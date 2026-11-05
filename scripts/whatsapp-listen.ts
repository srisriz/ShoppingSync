/**
 * WhatsApp listener: turns family group messages into shopping list items.
 *
 * Runs on your Mac while this Terminal window is open. Every message in the
 * family group is read; items are added to the list (matched to a shop by your
 * rules, or put in "Unassigned" for review), "got X" marks X bought, "cancel X"
 * removes it, and the bot reacts ✅ to each message it handled.
 *
 * Messages that arrive while the listener is off are picked up next time it
 * starts (WhatsApp delivers them on reconnect, within limits).
 *
 * Items no rule matches go to "Needs review". The local AI (Ollama on this Mac)
 * proposes a shop for each one; confirming it on the web page saves a rule.
 *
 * Send "list" in the group and the bot replies with the whole list, shop by shop.
 * "help" explains what the bot can do; "summary" gives today's list activity.
 * "Replace Riz with Rice" renames items and merges duplicates under the same shop.
 * Reply "Done" to that list message and every item on it is ticked off as bought;
 * "done costco" ticks off just the Costco items.
 * "add shop Lidl" (optionally "add shop Lidl: fruit, bread") creates a new shop.
 *
 * Run:  npm run wa:listen      Stop: Ctrl+C
 */
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createClient } from "@supabase/supabase-js";
import { parseMessageDetailed, type ParsedAction } from "../lib/parse";
import {
  buildSynonymGroups, findFamilyWord, groupList, isKnownItem, normalise, onlyKnownWords, sameItem, splitKnownWords,
  suggestShop, type KnownItems, type SynonymGroups,
} from "../lib/matching";
import { chatReply, checkOllama, extractActions, proposeShop, toEnglish, type AiShop, type ExtractedActions } from "../lib/ai";
import { formatListMessage, isListRequest } from "../lib/format";
import { formatSummary, HELP_TEXT, isHelpRequest, isSummaryRequest, startOfTodayUk, type SummaryItem } from "../lib/info";
import { matchShopName, parseAddShop, parseDone, parseReplace, parseSynonyms, parseTanglishMeans } from "../lib/commands";
import { planReplace, type ReplaceItem } from "../lib/replace";
import { generateToken, looksLikeCode, normaliseCode, sha256Hex } from "../lib/codes";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Optional: links an existing family (set up before multi-group) to its WhatsApp group by name.
const LEGACY_GROUP_NAME = (process.env.WHATSAPP_GROUP_NAME ?? "").trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
// Where the web console is reachable from family phones (used in private setup links).
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

const MAGIC_WORD_PROMPT = "👋 Hi, I'm ShoppingSync.\nReply to this group with your magic word.";
const ACTIVATION_WINDOW_MS = 24 * 3600 * 1000;   // no correct code within a day -> the bot leaves
const SETUP_LINK_TTL_MS = 48 * 3600 * 1000;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Fill in NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local first.");
  process.exit(1);
}

// The secret key bypasses row-level security; it never leaves this machine.
const db = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

type Family = { id: string; name: string };
type GroupRow = {
  id: string; name: string; status: "pending" | "active" | "inactive" | "left";
  whatsapp_group_jid: string | null; prompt_message_id: string | null; prompt_sent_at: string | null;
};
const GROUP_COLUMNS = "id, name, status, whatsapp_group_jid, prompt_message_id, prompt_sent_at";
type ItemRow = { id: string; item_key: string; requested_by: string[]; quantity: string | null; status: string };

/**
 * The group the current job belongs to. Jobs run strictly one at a time (see enqueue),
 * so each job switches to its own group first; everything it reads and writes is then
 * limited to that group.
 */
let family: Family | null = null;
let groupJid: string | undefined;
const cursors = new Map<string, number>(); // per group: unix seconds of the last processed message

function useGroup(g: GroupRow): void {
  family = { id: g.id, name: g.name };
  groupJid = g.whatsapp_group_jid ?? undefined;
}

/** Queue a follow-up job for the CURRENT group (it runs later, after other groups' jobs). */
function enqueueHere(job: () => Promise<void>): void {
  const f = family, j = groupJid;
  enqueue(async () => { family = f; groupJid = j; await job(); });
}
/**
 * One job at a time. Every message, and all background AI work (shop suggestions,
 * queued messages), goes through this single line; a job starts only when the
 * previous one has completely finished.
 */
let queue: Promise<void> = Promise.resolve();
let waiting = 0;

function enqueue(job: () => Promise<void>): void {
  waiting++;
  if (waiting > 1) console.log(`    … ${waiting - 1} job(s) waiting`);
  queue = queue
    .then(job)
    .catch((err) => console.error("    ✗", err instanceof Error ? err.message : err))
    .finally(() => { waiting--; });
}
const seen = new Set<string>(); // message ids handled this run (several can share a second)

let aiReady = false;
let currentSock: ReturnType<typeof makeWASocket> | null = null; // for reacting to queued messages later
let aiBusy = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toSeconds = (t: unknown) => (typeof t === "number" ? t : Number((t as { toString(): string } | null)?.toString() ?? 0));

/** Where the current group's processing has reached (first time: now, so old history is never imported). */
async function cursorFor(groupId: string): Promise<number> {
  if (!cursors.has(groupId)) {
    const { data } = await db.from("sync_state").select("message_cursor").eq("family_id", groupId).maybeSingle();
    cursors.set(groupId, data?.message_cursor ? Number(data.message_cursor) : Math.floor(Date.now() / 1000));
  }
  return cursors.get(groupId)!;
}

async function saveCursor(ts: number): Promise<void> {
  const fid = family!.id;
  const next = Math.max(await cursorFor(fid), ts);
  cursors.set(fid, next);
  await db.from("sync_state")
    .update({ message_cursor: String(next), last_synced_at: new Date().toISOString() })
    .eq("family_id", fid);
}

/** The current list as a WhatsApp message, shop by shop, plus the ids of the items on it. */
async function buildListMessage(): Promise<{ text: string; itemIds: string[] }> {
  const fid = family!.id;
  const [shopsRes, itemsRes] = await Promise.all([
    db.from("shops").select("id, name").eq("family_id", fid).order("priority").order("name"),
    db.from("items").select("id, name, quantity, shop_id").eq("family_id", fid).eq("status", "needed").order("created_at"),
  ]);
  const items = itemsRes.data ?? [];
  return { text: formatListMessage(shopsRes.data ?? [], items), itemIds: items.map((i) => i.id) };
}

// Which items each sent list contained, so "Done" clears exactly those.
// Kept in a small local file (git-ignored) so it survives restarts.
const LISTS_FILE = ".wa-lists.json";
type SentLists = Record<string, { itemIds: string[]; sentAt: string }>;

function readSentLists(): SentLists {
  try { return existsSync(LISTS_FILE) ? (JSON.parse(readFileSync(LISTS_FILE, "utf8")) as SentLists) : {}; }
  catch { return {}; }
}

function rememberSentList(messageId: string, itemIds: string[]): void {
  const lists = readSentLists();
  lists[messageId] = { itemIds, sentAt: new Date().toISOString() };
  const recent = Object.entries(lists).sort((a, b) => b[1].sentAt.localeCompare(a[1].sentAt)).slice(0, 30);
  writeFileSync(LISTS_FILE, JSON.stringify(Object.fromEntries(recent), null, 2));
}

/** Ticks off every item that was on the quoted list. Returns null if that message wasn't a list. */
async function clearList(listMessageId: string): Promise<{ cleared: number; remaining: number } | null> {
  const sent = readSentLists()[listMessageId];
  if (!sent) return null;
  const fid = family!.id;
  let cleared = 0;
  if (sent.itemIds.length) {
    const { data } = await db.from("items")
      .update({ status: "bought", bought_at: new Date().toISOString() })
      .eq("family_id", fid).eq("status", "needed").in("id", sent.itemIds)
      .select("id");
    cleared = data?.length ?? 0;
  }
  const { count } = await db.from("items").select("id", { count: "exact", head: true })
    .eq("family_id", fid).eq("status", "needed");
  return { cleared, remaining: count ?? 0 };
}

/** The family's synonym groups ("paal" = "milk"), loaded fresh so web-page edits apply at once. */
async function loadSynonyms(): Promise<SynonymGroups> {
  const { data } = await db.from("synonyms").select("word_a, word_b").eq("family_id", family!.id);
  return buildSynonymGroups(data ?? []);
}

/**
 * A clear list ("pal,coffee", "milk and eggs", one per line) keeps its shape:
 * each item is translated on its own, so translation can never join or drop items.
 * Family words ("pal") are kept as typed. Returns null if an item needs the AI
 * and the AI is off (the message is then parked).
 */
async function translateListItems(actions: ParsedAction[], groups: SynonymGroups, known?: KnownItems): Promise<ParsedAction[] | null> {
  const out: ParsedAction[] = [];
  for (const a of actions) {
    if (findFamilyWord(a.name, groups) || onlyKnownWords(a.name, groups) || (known && isKnownItem(a.name, known))) { out.push(a); continue; }
    if (!aiReady) return null;
    try {
      const t = await toEnglish(a.name, [...groups.keys()]);
      if (t.language !== "English" && t.english && t.english.toLowerCase() !== a.name.toLowerCase()) {
        console.log(`    item translated from ${t.language}: ${a.name} → ${t.english}`);
        out.push({ ...a, name: t.english });
      } else {
        out.push(a);
      }
    } catch (err) {
      aiReady = false;
      console.error("    AI unavailable:", err instanceof Error ? err.message : err);
      return null;
    }
  }
  return out;
}

/** Everything this group's list already knows: rules, shops' example items and synonyms. */
async function loadKnownItems(groups: SynonymGroups): Promise<KnownItems> {
  const fid = family!.id;
  const [rulesRes, shopsRes] = await Promise.all([
    db.from("rules").select("item_key, shop_id").eq("family_id", fid),
    db.from("shops").select("id, example_items, categories").eq("family_id", fid),
  ]);
  return { rules: rulesRes.data ?? [], shops: shopsRes.data ?? [], groups };
}

/** The AI's reading of a message, in the same shape the rules produce. */
function toActions(ex: ExtractedActions): ParsedAction[] {
  return [
    ...ex.add.map((a) => ({ kind: "add" as const, name: a.name, quantity: a.quantity })),
    ...ex.bought.map((name) => ({ kind: "bought" as const, name })),
    ...ex.remove.map((name) => ({ kind: "remove" as const, name })),
  ];
}

/**
 * Works out what a message asks for. Short lists are read by the rules;
 * sentences are read by the local AI. If the AI is unavailable the message
 * is queued and handled when it is back, so nothing is lost.
 */
type Preference = { item: string; shop: string };
type SynonymPairInput = { a: string; b: string };
type Reading = { actions: ParsedAction[]; preferences: Preference[]; fromAi: boolean; parked?: boolean; synonyms?: SynonymPairInput[] };

async function readMessage(text: string, sender: string, key: WAMessage["key"]): Promise<Reading> {
  const parsed = parseMessageDetailed(text);
  if (!parsed.needsAi) return { actions: parsed.actions, preferences: [], fromAi: false };
  if (aiReady) {
    try {
      const ex = await extractActions(text);
      const actions = toActions(ex);
      const said = [...actions.map((a) => `${a.kind} ${a.name}`), ...ex.preferences.map((p) => `prefer ${p.item} at ${p.shop}`)];
      console.log(`    AI read: ${said.length ? said.join(", ") : "no shopping items"}`);
      return { actions, preferences: ex.preferences, fromAi: true };
    } catch (err) {
      aiReady = false;
      console.error("    AI unavailable:", err instanceof Error ? err.message : err);
    }
  }
  return { actions: [], preferences: [], fromAi: false, parked: true };
}

// ---------------------------------------------------------------------------
// Fallback for messages that aren't shopping actions ("exception handling")

/** The phone-number part of a WhatsApp id, so ids in different forms can be compared. */
const idNumber = (jid?: string | null) => (jid ?? "").split("@")[0].split(":")[0];

/** Is this id the bot itself? (WhatsApp may use the phone id or the newer "lid" form.) */
function isBot(jid?: string | null): boolean {
  if (!jid || !currentSock?.user) return false;
  const me = [currentSock.user.id, (currentSock.user as { lid?: string }).lid].map(idNumber).filter(Boolean);
  return me.includes(idNumber(jid));
}

/**
 * Fallback for messages that aren't shopping actions ("exception handling").
 * Replies briefly only when the message is for the bot or the whole group AND the
 * AI is the right source. Hard rules first, so conversations between people are
 * never interrupted:
 *  - a reply to another person's message      -> silent
 *  - @mentions someone other than the bot     -> silent
 *  - starts with a family member's name       -> silent (unless it also names the bot)
 * Then the AI judges who it's for and whether it can answer. Silent when the AI is off.
 */
async function maybeChatReply(m: WAMessage, text: string, sender: string): Promise<void> {
  if (!aiReady || !currentSock || !groupJid) {
    console.log("    (nothing to add)");
    return;
  }
  const inner = m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message;
  const ctx = inner?.extendedTextMessage?.contextInfo;
  const quotedFrom = ctx?.quotedMessage ? ctx.participant : null;
  const mentioned = ctx?.mentionedJid ?? [];
  const toBot = isBot(quotedFrom) || mentioned.some(isBot) || /\b(?:shoppingsync|shopping\s*sync|bot)\b/i.test(text);

  if (quotedFrom && !isBot(quotedFrom)) {
    console.log("    (a reply to someone else's message; not answering)");
    return;
  }
  if (mentioned.length && !mentioned.some(isBot)) {
    console.log("    (mentions someone else; not answering)");
    return;
  }
  const { data: memberRows } = await db.from("members").select("display_name").eq("family_id", family!.id);
  const members = (memberRows ?? []).map((r) => r.display_name as string);
  const roles = ["amma", "appa", "mum", "mummy", "mom", "dad", "daddy", "papa", "paati", "thatha", "nani", "dadi", "nana",
    "anna", "akka", "thambi", "thangachi", "bhaiya", "didi", "aunty", "uncle"];
  const firstWord = normalise(text.split(/[\s,:!?]+/)[0] ?? "");
  const namesPerson = !!firstWord && (roles.includes(firstWord) || members.some((n) => normalise(n.split(/\s+/)[0]) === firstWord));
  if (namesPerson && !toBot) {
    console.log("    (addressed to a family member; not answering)");
    return;
  }

  try {
    const reply = await chatReply(text, sender, { members, toBot });
    if (!reply) {
      console.log("    (nothing to add; not one for the bot)");
      return;
    }
    await sleep(800 + Math.random() * 1200);
    await currentSock.sendMessage(groupJid, { text: reply }, { quoted: m });
    console.log(`    💬 replied: ${reply}`);
  } catch (err) {
    console.error("    chat reply failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Parking messages while the local AI is off

let napNotified = false; // the group is told once per nap; later parked messages just get 💤

/** Saves the message for later and lets the group know. Nothing is guessed while the AI is off. */
async function parkMessage(m: WAMessage, text: string, sender: string): Promise<void> {
  await db.from("ai_tasks").insert({
    family_id: family!.id, message_id: m.key.id, kind: "extract",
    input: { text, sender, key: m.key },
  });
  console.log("    😴 parked until the local AI is back");
  if (!currentSock || !groupJid) return;
  await sleep(800 + Math.random() * 1200);
  if (!napNotified) {
    napNotified = true;
    await currentSock.sendMessage(groupJid,
      { text: "😴 The LLM is taking a nap, so this message is parked and will be processed later." },
      { quoted: m });
  } else {
    await currentSock.sendMessage(groupJid, { react: { text: "💤", key: m.key } });
  }
}

// ---------------------------------------------------------------------------
// Confirmation questions for messages the AI read

const QUESTION_TTL_MS = 24 * 3600 * 1000;      // unanswered questions expire after a day
const BARE_ANSWER_WINDOW_MS = 30 * 60 * 1000;  // a plain "yes" (not a reply) counts for 30 minutes

const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const bold = (x: string) => `*${x}*`;

/** The shop a preference refers to: an existing shop if the name fits one, else a new shop name. */
function resolvePreferenceShop(said: string, shops: { id: string; name: string }[]): { id: string | null; name: string } {
  const match = matchShopName(said, shops);
  if (match.kind === "one") return match.shop;
  if (match.kind === "several") return match.shops.find((s) => normalise(s.name) === normalise(said)) ?? match.shops[0];
  return { id: null, name: said };
}

/** Asks the group to confirm what the AI read. Returns false if there was nothing to ask about. */
async function askToConfirm(
  jid: string, originalKey: WAMessage["key"], sender: string,
  reading: Pick<Reading, "actions" | "preferences" | "synonyms">,
  readAs?: string,   // set when an unsure translation is being checked: shown so the family sees the reading
): Promise<boolean> {
  const { actions, preferences } = reading;
  const synonymPairs = reading.synonyms ?? [];
  if (!currentSock || (actions.length === 0 && preferences.length === 0 && synonymPairs.length === 0)) {
    console.log("    (nothing to add)");
    return false;
  }
  const { data: shops } = await db.from("shops").select("id, name").eq("family_id", family!.id);
  const label = (a: ParsedAction) => bold(a.name) + (a.kind === "add" && a.quantity ? ` (${a.quantity})` : "");

  // An add plus a preference for the same thing reads as one step:
  // "add *Ramayana movie* under *iMax* (a new place)".
  const combined: string[] = [];
  const pairedAdds = new Set<ParsedAction>();
  const pairedPrefs = new Set<Preference>();
  for (const p of preferences) {
    const add = actions.find((a) => a.kind === "add" && normalise(a.name) === normalise(p.item) && !pairedAdds.has(a));
    if (!add) continue;
    const shop = resolvePreferenceShop(p.shop, shops ?? []);
    combined.push(`add ${label(add)} under ${bold(shop.name)}${shop.id ? "" : " (a new place)"}`);
    pairedAdds.add(add);
    pairedPrefs.add(p);
  }
  const adds = actions.filter((a) => a.kind === "add" && !pairedAdds.has(a)).map(label);
  const bought = actions.filter((a) => a.kind === "bought").map(label);
  const removed = actions.filter((a) => a.kind === "remove").map(label);
  const prefLines = preferences.filter((p) => !pairedPrefs.has(p)).map((p) => {
    const shop = resolvePreferenceShop(p.shop, shops ?? []);
    return shop.id
      ? { text: `always put ${bold(p.item)} on the ${bold(shop.name)} list`, single: `Shall I always put ${bold(p.item)} on the ${bold(shop.name)} list? Reply *yes* to confirm.` }
      : { text: `add ${bold(shop.name)} as a place and always put ${bold(p.item)} there`, single: `${shop.name} isn't one of your places yet. Reply *yes* to add ${bold(shop.name)} and always put ${p.item} there.` };
  });

  const lines = [
    ...combined,
    ...(adds.length ? [`add ${andList(adds)}`] : []),
    ...(bought.length ? [`tick off ${andList(bought)}`] : []),
    ...(removed.length ? [`remove ${andList(removed)}`] : []),
    ...prefLines.map((p) => p.text),
    ...synonymPairs.map((p) => `save ${bold(p.a)} = ${bold(p.b)}`),
  ];
  let text: string;
  if (prefLines.length === 1 && lines.length === 1) text = prefLines[0].single;
  else if (adds.length && lines.length === 1) text = `I'll add ${andList(adds)} to the list. Reply *yes* to confirm, or *no* to skip.`;
  else if (lines.length === 1) text = `Shall I ${lines[0]}? Reply *yes* to confirm, or *no* to skip.`;
  else text = `From that message, shall I:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nReply *yes* to confirm, or *no* to skip.`;
  if (readAs) text = `I read that as "${readAs}". ${text}`;

  await sleep(800 + Math.random() * 1200);
  const sent = await currentSock.sendMessage(jid, { text });
  if (!sent?.key.id) return false;
  await db.from("ai_tasks").insert({
    family_id: family!.id, message_id: sent.key.id, kind: "question", status: "queued",
    input: { actions, preferences, synonyms: synonymPairs, sender, key: originalKey },
  });
  console.log(`    ? asked the group to confirm: ${lines.join("; ")}`);
  return true;
}

/** "yes", "y", "👍" / "no", "skip", "👎" ... */
function parseAnswer(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:y|yes|yeah|yep|yup|yes please|sure|ok|okay|confirm|go ahead|do it|👍|✅|👌)$/u.test(t)) return "yes";
  if (/^(?:n|no|nope|nah|no thanks|skip|cancel|don'?t|👎|❌)$/u.test(t)) return "no";
  return null;
}

/** Applies preferences: creates the shop if needed, saves the rule, and moves the item if it's on the list. */
async function applyPreferences(preferences: Preference[]): Promise<{ count: number; saved: string[]; newPlaces: string[] }> {
  const fid = family!.id;
  let applied = 0;
  const saved: string[] = [], newPlaces: string[] = [];
  for (const p of preferences) {
    const { data: shops } = await db.from("shops").select("id, name, priority").eq("family_id", fid);
    let shop = resolvePreferenceShop(p.shop, shops ?? []);
    if (!shop.id) {
      const priority = Math.max(100, ...(shops ?? []).map((s) => s.priority)) + 10;
      const { data: created, error } = await db.from("shops")
        .insert({ family_id: fid, name: shop.name, example_items: [p.item], priority }).select("id, name").single();
      if (error || !created) { console.error(`    ✗ shop ${shop.name}: ${error?.message}`); continue; }
      shop = created;
      console.log(`    + shop ${created.name}`);
      newPlaces.push(created.name);
    }
    await db.from("rules").upsert(
      { family_id: fid, item_name: p.item, shop_id: shop.id, origin: "answer" },
      { onConflict: "family_id,item_key" },
    );
    await db.from("items").update({ shop_id: shop.id })
      .eq("family_id", fid).eq("status", "needed").eq("item_key", normalise(p.item));
    console.log(`    ✓ rule: ${p.item} → ${shop.name}`);
    saved.push(`${p.item} → ${shop.name}`);
    applied++;
  }
  return { count: applied, saved, newPlaces };
}

/**
 * Handles a yes/no. Returns false if there was no open question it could belong to,
 * so the message is treated as ordinary chat.
 */
async function handleAnswer(jid: string, key: WAMessage["key"], answer: "yes" | "no", answeredBy: string, quotedId?: string | null): Promise<boolean> {
  if (!currentSock) return false;
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  let query = db.from("ai_tasks").select("id, input, message_id")
    .eq("family_id", family!.id).eq("kind", "question").eq("status", "queued");
  query = quotedId
    ? query.eq("message_id", quotedId).gte("created_at", since(QUESTION_TTL_MS))
    : query.gte("created_at", since(BARE_ANSWER_WINDOW_MS));
  const { data: open } = await query.order("created_at", { ascending: false });
  if (!open?.length) return false;
  if (open.length > 1) {
    await currentSock.sendMessage(jid, { text: "I've asked a few questions; please reply *yes* or *no* directly to the one you mean." });
    return true;
  }
  const task = open[0];
  const input = task.input as {
    actions: ParsedAction[]; preferences: Preference[]; synonyms?: SynonymPairInput[]; sender: string; key: WAMessage["key"];
  };
  await sleep(600 + Math.random() * 900);
  if (answer === "no") {
    await db.from("ai_tasks").update({ status: "done", result: { answer: "no", by: answeredBy }, updated_at: new Date().toISOString() }).eq("id", task.id);
    await currentSock.sendMessage(jid, { text: "👍 Skipped." });
    console.log(`    ✗ ${answeredBy} said no; nothing changed`);
    return true;
  }
  const syn = input.synonyms?.length ? await saveSynonymPairs(input.synonyms) : null; // first, so matching uses them
  const prefs = await applyPreferences(input.preferences);          // first, so added items land in the new place
  const result = await applyActions(input.actions, input.sender, input.key.id ?? task.id);
  await db.from("ai_tasks").update({ status: "done", result: { answer: "yes", by: answeredBy, changes: result.changes, rules: prefs.count }, updated_at: new Date().toISOString() }).eq("id", task.id);
  const addedItems = new Set(input.actions.filter((a) => a.kind === "add").map((a) => normalise(a.name)));
  const ruleOnly = prefs.saved.filter((line) => !addedItems.has(normalise(line.split(" → ")[0])));
  const reply = [
    result.summary.replace(/^✅ /, "").replace(/\.$/, ""),
    prefs.newPlaces.length ? `New place: ${andList(prefs.newPlaces)}` : "",
    ruleOnly.length ? `Saved: ${andList(ruleOnly)}` : "",
    syn?.saved.length ? `Saved: ${andList(syn.saved)}` : "",
    syn?.already.length ? `${andList(syn.already)} ${syn.already.length === 1 ? "was" : "were"} already saved` : "",
    syn?.moved ? `Moved ${items(syn.moved)} out of review` : "",
  ].filter(Boolean).join(". ");
  await currentSock.sendMessage(jid, { text: `✅ ${reply || "Done"}.` });
  console.log(`    ✓ ${answeredBy} confirmed: ${result.changes} list change(s), ${prefs.count} rule(s)`);
  enqueueHere(proposeForReviewItems);
  return true;
}

/** Reads queued messages once the AI is available, then reacts ✅ to the original message. */
async function processQueuedMessages(): Promise<void> {
  if (!family || !aiReady) return;
  const { data: tasks } = await db.from("ai_tasks").select("id, input")
    .eq("family_id", family.id).eq("kind", "extract").eq("status", "queued")
    .order("created_at").limit(5);
  for (const task of tasks ?? []) {
    const input = task.input as { text: string; sender: string; key: WAMessage["key"] };
    try {
      await db.from("ai_tasks").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", task.id);
      console.log(`[parked, ${input.sender}] ${input.text.replace(/\n/g, " / ")}`);
      const t = await toEnglish(input.text, [...(await loadSynonyms()).keys()]);
      const unsure = t.language !== "English" && t.confidence < 0.7;
      if (t.language !== "English") console.log(`    translated from ${t.language} (${Math.round(t.confidence * 100)}% sure): ${t.english}`);
      const reading = await readMessage(t.english, input.sender, input.key);
      if (reading.parked) throw new Error("the AI stopped again");
      await db.from("ai_tasks").update({ status: "done", result: reading, updated_at: new Date().toISOString() }).eq("id", task.id);
      if (!groupJid || !currentSock) continue;
      if (reading.fromAi || unsure) {
        await askToConfirm(groupJid, input.key, input.sender, reading, unsure ? t.english : undefined);
      } else {
        const result = await applyActions(reading.actions, input.sender, input.key.id ?? task.id);
        if (result.summary) {
          await sleep(800 + Math.random() * 1200);
          await currentSock.sendMessage(groupJid, { text: `${result.summary.replace(/\.$/, "")} (from ${input.sender}'s earlier message).` });
        }
      }
    } catch (err) {
      await db.from("ai_tasks").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", task.id);
      aiReady = false;
      console.error("    AI unavailable for queued message:", err instanceof Error ? err.message : err);
      return;
    }
  }
}

/** Applies a message's actions to the list. Returns how many list changes it made. */
type ApplyResult = { changes: number; summary: string };
const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** Applies a message's actions to the list, with a short summary for the group. */
async function applyActions(actions: ParsedAction[], sender: string, messageId: string): Promise<ApplyResult> {
  if (actions.length === 0) return { changes: 0, summary: "" };
  const fid = family!.id;

  const [shopsRes, rulesRes, itemsRes, membersRes, synonyms] = await Promise.all([
    db.from("shops").select("id, name, example_items, categories").eq("family_id", fid).order("priority").order("name"),
    db.from("rules").select("item_key, shop_id").eq("family_id", fid),
    db.from("items").select("id, item_key, requested_by, quantity, status").eq("family_id", fid).eq("status", "needed"),
    db.from("members").select("display_name").eq("family_id", fid),
    loadSynonyms(),
  ]);
  const shops = shopsRes.data ?? [];
  const rules = rulesRes.data ?? [];
  const needed: ItemRow[] = itemsRes.data ?? [];
  const requester =
    (membersRes.data ?? []).find((m) => normalise(m.display_name) === normalise(sender))?.display_name ?? sender;

  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const added: string[] = [], updated: string[] = [], bought: string[] = [], removed: string[] = [], missing: string[] = [];
  let changes = 0;
  for (const action of actions) {
    const key = normalise(action.name);
    const existing = needed.find((it) => sameItem(it.item_key, key, synonyms)); // "paal" merges into "milk"

    if (action.kind === "add") {
      if (existing) {
        const requested_by = existing.requested_by.includes(requester) ? existing.requested_by : [...existing.requested_by, requester];
        const isExtra = !!action.quantity && (action.quantity === "extra" || action.quantity.startsWith("+"));
        const quantity = isExtra && existing.quantity
          ? `${existing.quantity} + ${action.quantity!.replace(/^\+/, "")}`
          : action.quantity ?? existing.quantity;
        await db.from("items").update({ requested_by, quantity }).eq("id", existing.id);
        console.log(`    = ${action.name} (already on the list; added ${requester})`);
        updated.push(quantity ? `${action.name} (${quantity})` : action.name);
      } else {
        const shop_id = suggestShop(key, rules, shops, synonyms);
        const { data, error } = await db.from("items").insert({
          family_id: fid, name: action.name, quantity: action.quantity, shop_id,
          requested_by: [requester], source: "whatsapp", source_message_id: messageId,
        }).select("id, item_key, requested_by, quantity, status").single();
        if (error) { console.error(`    ✗ ${action.name}: ${error.message}`); continue; }
        needed.push(data);
        console.log(`    + ${action.name}${action.quantity ? ` (${action.quantity})` : ""} → ${shop_id ? "matched to a shop by a rule" : "Needs review"}`);
        added.push(`${action.name} (${shop_id ? shopName.get(shop_id) : "needs review"})`);
      }
      changes++;
    } else if (existing) {
      const status = action.kind === "bought" ? "bought" : "removed";
      await db.from("items").update({ status, bought_at: status === "bought" ? new Date().toISOString() : null }).eq("id", existing.id);
      console.log(`    ${status === "bought" ? "✓" : "−"} ${action.name} (${status})`);
      (status === "bought" ? bought : removed).push(action.name);
      changes++;
    } else {
      console.log(`    ? ${action.name}: not on the list, nothing to ${action.kind === "bought" ? "tick" : "remove"}`);
      missing.push(action.name);
    }
  }
  const parts = [
    added.length ? `Added ${andList(added)}` : "",
    updated.length ? `Updated ${andList(updated)}` : "",
    bought.length ? `Ticked off ${andList(bought)}` : "",
    removed.length ? `Removed ${andList(removed)}` : "",
    missing.length ? `${andList(missing)} ${missing.length === 1 ? "wasn't" : "weren't"} on the list` : "",
  ].filter(Boolean);
  return { changes, summary: parts.length ? `${changes > 0 ? "✅ " : ""}${parts.join(". ")}.` : "" };
}

type Sock = ReturnType<typeof makeWASocket>;
type MsgKey = WAMessage["key"];

/**
 * "Done" handling.
 *   Done (reply to a list)        -> tick off everything on that list
 *   done costco                   -> tick off every Costco item now on the list
 *   done costco (reply to a list) -> tick off the Costco items that were on that list
 * A "done" that matches nothing is left alone, so chat like "done for today" is harmless.
 */
async function handleDone(sock: Sock, jid: string, key: MsgKey, shopSaid: string | null, quotedId?: string | null): Promise<void> {
  const fid = family!.id;
  const quotedList = quotedId ? readSentLists()[quotedId] : undefined;
  const pause = () => sleep(800 + Math.random() * 1200);

  if (!shopSaid) {
    if (!quotedList) { console.log("    (Done, but not as a reply to a list; left alone)"); return; }
    const result = await clearList(quotedId!);
    await pause();
    const since = result!.remaining > 0 ? ` ${items(result!.remaining)} added since is still on; send "list" to see.` : "";
    await sock.sendMessage(jid, { text: `✅ Ticked off ${items(result!.cleared)}.${since}` });
    console.log(`    ✓ Done: ticked off ${result!.cleared} item(s); ${result!.remaining} still on the list`);
    return;
  }

  const { data: shops } = await db.from("shops").select("id, name").eq("family_id", fid).order("priority");
  const match = matchShopName(shopSaid, shops ?? []);
  if (match.kind === "none") {
    console.log(`    (done "${shopSaid}": no shop by that name; left alone)`);
    if (quotedList) {
      await pause();
      await sock.sendMessage(jid, { text: `I don't know a shop called "${shopSaid}". Your shops: ${(shops ?? []).map((s) => s.name).join(", ")}.` });
    }
    return;
  }
  if (match.kind === "several") {
    await pause();
    await sock.sendMessage(jid, { text: `Which one: ${match.shops.map((s) => s.name).join(" or ")}? Reply e.g. "done ${match.shops[0].name}".` });
    return;
  }

  let query = db.from("items")
    .update({ status: "bought", bought_at: new Date().toISOString() })
    .eq("family_id", fid).eq("status", "needed").eq("shop_id", match.shop.id);
  if (quotedList) query = query.in("id", quotedList.itemIds);
  const { data: cleared } = await query.select("id");
  const n = cleared?.length ?? 0;
  await pause();
  if (n === 0) {
    await sock.sendMessage(jid, { text: `Nothing left on the ${match.shop.name} list.` });
    console.log(`    (done ${match.shop.name}: nothing to tick off)`);
    return;
  }
  await sock.sendMessage(jid, { text: `✅ Ticked off ${items(n)} at ${match.shop.name}.` });
  console.log(`    ✓ Done at ${match.shop.name}: ticked off ${n} item(s)`);
}

/**
 * "paal means milk" (or several pairs: "paal means milk and thayir means curd")
 * -> saves the pairs, then re-checks Needs review: items a synonym can now place
 * are moved to their shop. One short reply for the whole message.
 */
async function handleSynonyms(jid: string, pairs: SynonymPairInput[]): Promise<void> {
  if (!currentSock) return;
  const { saved, already, moved } = await saveSynonymPairs(pairs);
  const reply = [
    saved.length ? `✅ Saved: ${andList(saved)}.` : "",
    already.length ? `${andList(already)} ${already.length === 1 ? "was" : "were"} already saved.` : "",
    moved ? `Moved ${items(moved)} out of review.` : "",
  ].filter(Boolean).join(" ");
  await sleep(800 + Math.random() * 1200);
  if (reply) await currentSock.sendMessage(jid, { text: reply });
  console.log(`    ✓ synonyms: ${reply}`);
}

/** Saves synonym pairs and moves any Needs review items they can now place. */
async function saveSynonymPairs(pairs: SynonymPairInput[]): Promise<{ saved: string[]; already: string[]; moved: number }> {
  const fid = family!.id;
  const saved: string[] = [], already: string[] = [];
  for (const { a, b } of pairs) {
    const groups = await loadSynonyms();
    if (sameItem(normalise(a), normalise(b), groups)) { already.push(`${a} = ${b}`); continue; }
    const { error } = await db.from("synonyms").insert({ family_id: fid, word_a: a, word_b: b });
    if (error) { console.error(`    ✗ synonym ${a} = ${b}: ${error.message}`); continue; }
    saved.push(`${a} = ${b}`);
  }

  let moved = 0;
  if (saved.length) {
    const groups = await loadSynonyms();
    const [shopsRes, rulesRes, reviewRes] = await Promise.all([
      db.from("shops").select("id, name, example_items, categories").eq("family_id", fid).order("priority").order("name"),
      db.from("rules").select("item_key, shop_id").eq("family_id", fid),
      db.from("items").select("id, item_key").eq("family_id", fid).eq("status", "needed").is("shop_id", null),
    ]);
    for (const item of reviewRes.data ?? []) {
      const shop_id = suggestShop(item.item_key, rulesRes.data ?? [], shopsRes.data ?? [], groups);
      if (!shop_id) continue;
      await db.from("items").update({ shop_id }).eq("id", item.id);
      moved++;
    }
  }

  return { saved, already, moved };
}

/**
 * "Replace Riz with Rice": renames matching items on the current list, then merges
 * items with the new name under the same shop (never across shops). Renamed items
 * that were in Needs review get a fresh shop match for the new name.
 */
async function handleReplace(jid: string, m: WAMessage, from: string, to: string): Promise<void> {
  if (!currentSock) return;
  const fid = family!.id;
  const { data } = await db.from("items")
    .select("id, name, shop_id, quantity, requested_by, created_at, status")
    .eq("family_id", fid).eq("status", "needed");
  const plan = planReplace((data ?? []) as ReplaceItem[], from, to);
  await sleep(800 + Math.random() * 1200);
  if (plan.renamed.length === 0) {
    await currentSock.sendMessage(jid, { text: `No ${from} on the list.` }, { quoted: m });
    console.log(`    (replace: no ${from} on the list)`);
    return;
  }

  for (const u of plan.updates) {
    await db.from("items").update({ name: u.name, quantity: u.quantity, requested_by: u.requested_by }).eq("id", u.id);
  }
  if (plan.deletes.length) await db.from("items").delete().in("id", plan.deletes);

  // Renamed items still in Needs review: try the new name against rules and synonyms.
  const [shopsRes, rulesRes, synonyms] = await Promise.all([
    db.from("shops").select("id, name, example_items, categories").eq("family_id", fid).order("priority").order("name"),
    db.from("rules").select("item_key, shop_id").eq("family_id", fid),
    loadSynonyms(),
  ]);
  const shopName = new Map((shopsRes.data ?? []).map((s) => [s.id, s.name]));
  const survivors = plan.updates.map((u) => u.id);
  const { data: review } = await db.from("items").select("id").in("id", survivors).is("shop_id", null);
  let placed = 0;
  for (const r of review ?? []) {
    const shop_id = suggestShop(normalise(to), rulesRes.data ?? [], shopsRes.data ?? [], synonyms);
    if (shop_id) { await db.from("items").update({ shop_id }).eq("id", r.id); placed++; }
    else await db.from("items").update({ proposed_at: null, proposed_shop_id: null }).eq("id", r.id); // AI looks again
  }

  const where = plan.mergedShops.map((g) => (g.shop_id ? shopName.get(g.shop_id) ?? "a shop" : "Needs review"));
  const reply = [
    `✅ Replaced ${from} with ${to} (${items(plan.renamed.length)}).`,
    where.length ? `Merged duplicates at ${andList(where)}.` : "",
    placed ? `Moved ${items(placed)} out of review.` : "",
  ].filter(Boolean).join(" ");
  await currentSock.sendMessage(jid, { text: reply }, { quoted: m });
  console.log(`    ✓ ${reply}`);
  enqueueHere(proposeForReviewItems);
}

/** "add shop Lidl" -> creates the shop (and starting rules for any example items). */
async function handleAddShop(sock: Sock, jid: string, key: MsgKey, name: string, exampleItems: string[]): Promise<void> {
  const fid = family!.id;
  const pause = () => sleep(800 + Math.random() * 1200);

  const { data: shops } = await db.from("shops").select("id, name, priority").eq("family_id", fid);
  const existing = (shops ?? []).find((s) => normalise(s.name) === normalise(name));
  if (existing) {
    await pause();
    await sock.sendMessage(jid, { text: `${existing.name} is already one of your shops.` });
    console.log(`    (add shop ${name}: already exists)`);
    return;
  }

  // New shops go to the end of the priority order; change it on the family profile page.
  const priority = Math.max(100, ...(shops ?? []).map((s) => s.priority)) + 10;
  const { data: shop, error } = await db.from("shops")
    .insert({ family_id: fid, name, example_items: exampleItems, priority })
    .select("id, name").single();
  if (error || !shop) {
    console.error(`    ✗ add shop ${name}: ${error?.message}`);
    return;
  }
  if (exampleItems.length) {
    await db.from("rules").upsert(
      exampleItems.map((item_name) => ({ family_id: fid, item_name, shop_id: shop.id, origin: "setup" })),
      { onConflict: "family_id,item_key" },
    );
  }
  // Let the AI take another look at review items it couldn't place before.
  await db.from("items").update({ proposed_at: null })
    .eq("family_id", fid).eq("status", "needed").is("shop_id", null).is("proposed_shop_id", null);
  enqueueHere(proposeForReviewItems);

  await pause();
  const extra = exampleItems.length ? ` with ${exampleItems.join(", ")}` : "";
  await sock.sendMessage(jid, { text: `✅ Added shop *${shop.name}*${extra}.` });
  console.log(`    + shop ${shop.name}${extra}`);
}

// ---------------------------------------------------------------------------
// Groups: every WhatsApp group the bot is in is its own shopping group

async function groupByJid(jid: string): Promise<GroupRow | null> {
  const { data } = await db.from("families").select(GROUP_COLUMNS).eq("whatsapp_group_jid", jid).maybeSingle();
  return (data as GroupRow | null) ?? null;
}

async function sendPrompt(sock: Sock, g: GroupRow): Promise<void> {
  const sent = await sock.sendMessage(g.whatsapp_group_jid!, { text: MAGIC_WORD_PROMPT });
  await db.from("families").update({ prompt_message_id: sent?.key.id ?? null, prompt_sent_at: new Date().toISOString() }).eq("id", g.id);
  console.log(`? asked "${g.name}" for the magic word`);
}

/**
 * Makes sure a WhatsApp group the bot is in has a row:
 *  - already known and active    -> nothing to do
 *  - new                         -> pending, and the bot asks for the magic word
 *  - re-added after leaving      -> pending again, asks again
 *  - an existing family set up before multi-group (matched by name) -> linked, stays active
 */
async function ensureGroup(jid: string, subject: string): Promise<GroupRow | null> {
  const sock = currentSock;
  if (!sock) return null;
  let g = await groupByJid(jid);

  if (!g) {
    // Before multi-group, the one family was found by name: link it once, no magic word needed.
    const legacyName = LEGACY_GROUP_NAME || subject;
    const { data: legacy } = await db.from("families").select(GROUP_COLUMNS)
      .is("whatsapp_group_jid", null).eq("status", "active").ilike("whatsapp_group_name", legacyName).limit(1);
    if (legacy?.length && normalise(legacyName) === normalise(subject)) {
      await db.from("families").update({ whatsapp_group_jid: jid }).eq("id", legacy[0].id);
      console.log(`✓ linked existing family "${legacy[0].name}" to its WhatsApp group`);
      return groupByJid(jid);
    }
    const { data: created, error } = await db.from("families")
      .insert({ name: subject, whatsapp_group_name: subject, whatsapp_group_jid: jid, status: "pending" })
      .select(GROUP_COLUMNS).single();
    if (error || !created) { console.error(`✗ could not register group "${subject}": ${error?.message}`); return null; }
    g = created as GroupRow;
    console.log(`+ added to a new group "${subject}"`);
    await sendPrompt(sock, g);
    return groupByJid(jid);
  }

  if (g.status === "inactive" || g.status === "left") {
    await db.from("families").update({ status: "pending", prompt_message_id: null, prompt_sent_at: null }).eq("id", g.id);
    console.log(`+ re-added to "${g.name}"; asking for the magic word again`);
    await sendPrompt(sock, { ...g, status: "pending" });
    return groupByJid(jid);
  }
  if (g.status === "pending" && !g.prompt_sent_at) {
    await sendPrompt(sock, g);
    return groupByJid(jid);
  }
  if (subject && g.status === "active") {
    await db.from("families").update({ whatsapp_group_name: subject }).eq("id", g.id);
  }
  return g;
}

/** On connect: register every group the bot is in; groups it has left are marked inactive. */
async function syncGroups(sock: Sock): Promise<void> {
  const groups = Object.values(await sock.groupFetchAllParticipating());
  for (const meta of groups) await ensureGroup(meta.id, meta.subject);
  const inGroups = new Set(groups.map((x) => x.id));
  const { data: known } = await db.from("families").select("id, name, whatsapp_group_jid")
    .in("status", ["active", "pending"]).not("whatsapp_group_jid", "is", null);
  for (const k of known ?? []) {
    if (!inGroups.has(k.whatsapp_group_jid)) {
      await db.from("families").update({ status: "inactive" }).eq("id", k.id);
      console.log(`− no longer in "${k.name}"; marked inactive (its data is kept)`);
    }
  }
  const { data: active } = await db.from("families").select("name").eq("status", "active").not("whatsapp_group_jid", "is", null);
  console.log(`✓ Listening to ${active?.length ?? 0} active group(s): ${(active ?? []).map((a) => `"${a.name}"`).join(", ") || "none yet"}.`);
  console.log("  Leave this window open; press Ctrl+C to stop.\n");
  await leaveExpiredGroups();
}

/** Says goodbye and leaves the group, marking it as left. */
async function leaveGroup(sock: Sock, g: GroupRow, goodbye: string): Promise<void> {
  try {
    await sock.sendMessage(g.whatsapp_group_jid!, { text: goodbye });
    await sleep(1500);
    await sock.groupLeave(g.whatsapp_group_jid!);
  } catch (err) {
    console.error(`    ✗ leaving "${g.name}":`, err instanceof Error ? err.message : err);
  }
  await db.from("families").update({ status: "left" }).eq("id", g.id);
  console.log(`− left "${g.name}"`);
}

/** Pending groups that never gave the magic word within 24 hours. */
async function leaveExpiredGroups(): Promise<void> {
  if (!currentSock) return;
  const cutoff = new Date(Date.now() - ACTIVATION_WINDOW_MS).toISOString();
  const { data } = await db.from("families").select(GROUP_COLUMNS).eq("status", "pending").lt("prompt_sent_at", cutoff);
  for (const g of (data ?? []) as GroupRow[]) {
    await leaveGroup(currentSock, g, "No magic word arrived within a day, so I'm leaving this group. Ask the super user for a magic word and add me again.");
  }
}

/**
 * A message in a group that hasn't given the magic word yet. Only a reply to the
 * prompt, or a message that looks like a code ("MANGO-4821"), counts as an attempt;
 * other chat is ignored. A wrong attempt: the bot leaves straight away.
 */
async function handleActivation(sock: Sock, g: GroupRow, m: WAMessage, text: string, sender: string, ts: number): Promise<void> {
  if (!text) return;
  if (g.prompt_sent_at && ts * 1000 < Date.parse(g.prompt_sent_at) - 60_000) return; // from before the bot arrived
  const inner = m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message;
  const repliedToPrompt = !!g.prompt_message_id && inner?.extendedTextMessage?.contextInfo?.stanzaId === g.prompt_message_id;
  if (!repliedToPrompt && !looksLikeCode(text)) {
    console.log(`[${g.name}] (waiting for the magic word; ignored)`);
    return;
  }
  console.log(`[${g.name}] magic word attempt by ${sender}`);

  // Check and spend the code in one step, so it can never be used twice.
  const hash = await sha256Hex(normaliseCode(text));
  const now = new Date().toISOString();
  // The code must have been made for THIS group: a valid code for another group is still wrong here.
  const { data: claimed } = await db.from("activation_codes")
    .update({ used_at: now, used_by_family: g.id })
    .eq("code_hash", hash).eq("family_id", g.id).is("used_at", null)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .select("id");
  await sleep(800 + Math.random() * 1200);
  if (!claimed?.length) {
    await leaveGroup(sock, g, "❌ That's not the magic word, so I'm leaving this group. Ask the super user for a magic word, then add me again.");
    return;
  }

  const senderJid = (m.key as { participantPn?: string }).participantPn ?? m.key.participant ?? "";
  await db.from("families").update({ status: "active", activated_at: now, activated_by: senderJid }).eq("id", g.id);
  cursors.set(g.id, ts);
  await db.from("sync_state").update({ message_cursor: String(ts), last_synced_at: now }).eq("family_id", g.id);
  console.log(`✓ "${g.name}" is now active`);

  // A private, one-time link for this group's console login, sent only to whoever typed the code.
  const token = generateToken();
  await db.from("setup_tokens").insert({
    family_id: g.id, token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + SETUP_LINK_TTL_MS).toISOString(),
  });
  let dmSent = false;
  if (senderJid) {
    try {
      await sock.sendMessage(senderJid, {
        text: `Here's your one-time link to set up the ShoppingSync console for "${g.name}":\n${BASE_URL}/setup?t=${token}\n\nIt works once and expires in 48 hours.`,
      });
      dmSent = true;
    } catch (err) {
      console.error("    ✗ could not send the setup link privately:", err instanceof Error ? err.message : err);
    }
  }
  await sock.sendMessage(g.whatsapp_group_jid!, {
    text: `✅ Magic word accepted. ShoppingSync is on for this group.` +
      (dmSent ? ` ${sender}, I've sent you a private link to set up this group's console.` : " The super user can send a console setup link.") +
      ` Send "help" to see what I can do.`,
  }, { quoted: m });
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(".wa-session");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["ShoppingSync", "Chrome", "1.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);
  currentSock = sock;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nOn the BOT phone: WhatsApp > Settings > Linked devices > Link a device, then scan:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      enqueue(() => syncGroups(sock));
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("\n✗ WhatsApp logged this device out. Delete the .wa-session folder and run again to re-link.");
        process.exit(1);
      }
      console.log(`Connection dropped (${code ?? "unknown"}). Reconnecting in 5s…`);
      await sleep(5000);
      void connect();
    }
  });

  // The bot was added to a new group: it becomes a shopping group, pending the magic word.
  sock.ev.on("groups.upsert", (groups) => {
    for (const g of groups) enqueue(async () => { await ensureGroup(g.id, g.subject); });
  });
  // Added to or removed from a group while running.
  sock.ev.on("group-participants.update", ({ id, participants, action }) => {
    const ids = (participants as unknown[]).map((p) => (typeof p === "string" ? p : (p as { id?: string }).id ?? ""));
    if (!ids.some(isBot)) return;
    enqueue(async () => {
      if (action === "remove") {
        await db.from("families").update({ status: "inactive" }).eq("whatsapp_group_jid", id).in("status", ["active", "pending"]);
        console.log(`− removed from group ${id}; marked inactive (its data is kept)`);
      } else if (action === "add") {
        const meta = await sock.groupMetadata(id).catch(() => null);
        await ensureGroup(id, meta?.subject ?? "WhatsApp group");
      }
    });
  });

  // "notify" = new messages; "append" = messages delivered after being offline.
  sock.ev.on("messages.upsert", ({ messages }) => {
    const ordered = [...messages].sort((a, b) => toSeconds(a.messageTimestamp) - toSeconds(b.messageTimestamp));
    for (const m of ordered) {
      enqueue(async () => {
        const jid = m.key.remoteJid;
        if (!jid?.endsWith("@g.us") || m.key.fromMe || !m.key.id) return;   // groups only
        if (seen.has(m.key.id)) return;
        let g = await groupByJid(jid);
        if (!g) {
          const meta = await sock.groupMetadata(jid).catch(() => null);
          g = await ensureGroup(jid, meta?.subject ?? "WhatsApp group");
          if (!g) return;
        }
        const ts = toSeconds(m.messageTimestamp);
        const msg = m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message;
        const text = msg?.conversation ?? msg?.extendedTextMessage?.text ?? "";
        const sender = m.pushName ?? "WhatsApp";
        if (g.status === "pending") {
          seen.add(m.key.id);
          await handleActivation(sock, g, m, text, sender, ts);   // nothing else works until the magic word
          return;
        }
        if (g.status !== "active") return;
        useGroup(g);
        if (!groupJid) return;
        if (ts < (await cursorFor(g.id))) return; // already handled
        seen.add(m.key.id);
        if (text) {
          console.log(`[${sender}] ${text.replace(/\n/g, " / ")}`);
          try {
            // Other languages: translate to English first, then handle exactly like English.
            // Commands and yes/no answers are recognised as they are, without the AI.
            let english = text;
            let unsure = false; // an unsure translation is shown to the family and confirmed before anything changes
            const isCommand = isListRequest(text) || isHelpRequest(text) || isSummaryRequest(text) || !!parseAddShop(text) || !!parseDone(text) ||
              !!parseAnswer(text) || !!parseSynonyms(text) || !!parseReplace(text) || !!parseTanglishMeans(text);
            const synonyms = isCommand ? null : await loadSynonyms();
            const ruleReading = isCommand ? null : parseMessageDetailed(text);
            const plainChat = !!ruleReading && !ruleReading.needsAi && ruleReading.actions.length === 0; // "ok", 👍
            // A clear list of 2+ items keeps its shape: items are translated one by one, never the whole message.
            let listShape = !!ruleReading && !ruleReading.needsAi && ruleReading.actions.length >= 2 ? ruleReading.actions : null;
            // "pal coffee", "milk eggs bread": split on spaces only when EVERY piece is something the list knows.
            const known = synonyms && ruleReading && !ruleReading.needsAi ? await loadKnownItems(synonyms) : undefined;
            if (!listShape && known && ruleReading?.actions.length) {
              const split = ruleReading.actions.flatMap((a) => {
                const parts = splitKnownWords(a.name, known);
                if (!parts) return [a];
                return parts.map((name, i): ParsedAction =>
                  a.kind === "add" ? { kind: "add", name, quantity: i === 0 ? a.quantity : null } : { kind: a.kind, name });
              });
              if (split.length >= 2) {
                listShape = split;
                console.log(`    split into known items: ${split.map((a) => a.name).join(", ")}`);
              }
            }
            let listActions: ParsedAction[] | null = null;
            if (plainChat) {
              // no translation, never parked
            } else if (listShape && synonyms) {
              listActions = await translateListItems(listShape, synonyms, known);
              if (!listActions) {
                await parkMessage(m, text, sender);
                await saveCursor(ts);
                return;
              }
              console.log(`    list kept as ${listActions.length} items`);
            } else if (!isCommand && synonyms && onlyKnownWords(text, synonyms)) {
              console.log("    only family words; no translation needed");
            } else if (!isCommand) {
              let translated = false;
              if (aiReady) {
                try {
                  const t = await toEnglish(text, [...(synonyms?.keys() ?? [])]);
                  translated = true;
                  if (t.language !== "English") {
                    english = t.english;
                    unsure = t.confidence < 0.7;
                    console.log(`    translated from ${t.language} (${Math.round(t.confidence * 100)}% sure): ${english}`);
                  }
                } catch (err) {
                  aiReady = false;
                  console.error("    AI unavailable:", err instanceof Error ? err.message : err);
                }
              }
              if (!translated) {
                await parkMessage(m, text, sender);
                await saveCursor(ts);
                return;
              }
            }
            if (isListRequest(english)) {
              await sleep(800 + Math.random() * 1200);
              const list = await buildListMessage();
              const sent = await sock.sendMessage(groupJid, { text: list.text }, { quoted: m });
              if (sent?.key.id) rememberSentList(sent.key.id, list.itemIds);
              console.log(`    → sent the shopping list (${list.itemIds.length} items)`);
              await saveCursor(ts);
              return;
            }
            if (isHelpRequest(english)) {
              await sleep(800 + Math.random() * 1200);
              await sock.sendMessage(groupJid, { text: HELP_TEXT }, { quoted: m });
              console.log("    → sent help");
              await saveCursor(ts);
              return;
            }
            if (isSummaryRequest(english)) {
              const since = startOfTodayUk().toISOString();
              const { data } = await db.from("items")
                .select("name, status, shop_id, requested_by, created_at, bought_at")
                .eq("family_id", family!.id)
                .or(`status.eq.needed,created_at.gte.${since},bought_at.gte.${since}`);
              await sleep(800 + Math.random() * 1200);
              await sock.sendMessage(groupJid, { text: formatSummary((data ?? []) as SummaryItem[]) }, { quoted: m });
              console.log("    → sent today's summary");
              await saveCursor(ts);
              return;
            }
            const replace = parseReplace(english);
            if (replace) {
              await handleReplace(groupJid, m, replace.from, replace.to);
              await saveCursor(ts);
              return;
            }
            const synonymPairs = parseSynonyms(english);
            if (synonymPairs) {
              if (unsure) await askToConfirm(groupJid, m.key, sender, { actions: [], preferences: [], synonyms: synonymPairs }, english);
              else await handleSynonyms(groupJid, synonymPairs);
              await saveCursor(ts);
              return;
            }
            // Tanglish "riz na rice": recognised by the app, but always confirmed ("na" can mean "don't").
            const tanglishPair = parseTanglishMeans(text);
            if (tanglishPair) {
              const groups = await loadSynonyms();
              if (sameItem(normalise(tanglishPair.a), normalise(tanglishPair.b), groups)) {
                await sleep(800 + Math.random() * 1200);
                await sock.sendMessage(groupJid, { text: `${tanglishPair.a} and ${tanglishPair.b} are already the same.` }, { quoted: m });
              } else {
                await askToConfirm(groupJid, m.key, sender, { actions: [], preferences: [], synonyms: [tanglishPair] });
              }
              await saveCursor(ts);
              return;
            }
            const addShop = parseAddShop(english);
            if (addShop) {
              await handleAddShop(sock, groupJid, m.key, addShop.name, addShop.exampleItems);
              await saveCursor(ts);
              return;
            }
            const quotedId = msg?.extendedTextMessage?.contextInfo?.stanzaId;
            const answer = parseAnswer(english);
            if (answer && (await handleAnswer(groupJid, m.key, answer, sender, quotedId))) {
              await saveCursor(ts);
              return;
            }
            const done = parseDone(english);
            if (done) {
              await handleDone(sock, groupJid, m.key, done.shop, quotedId);
              await saveCursor(ts);
              return;
            }
            const reading: Reading = listActions
              ? { actions: listActions, preferences: [], fromAi: false }
              : await readMessage(english, sender, m.key);
            if (reading.parked) {
              await parkMessage(m, text, sender);
              await saveCursor(ts);
              return;
            }
            if (reading.fromAi || unsure) {
              // the AI's reading (or an unsure translation) is confirmed first
              const asked = await askToConfirm(groupJid, m.key, sender, reading, unsure ? english : undefined);
              if (!asked) await maybeChatReply(m, text, sender);
              await saveCursor(ts);
              return;
            }
            const result = await applyActions(reading.actions, sender, m.key.id);
            if (result.summary) {
              await sleep(800 + Math.random() * 1200); // a human-like pause before replying
              await sock.sendMessage(groupJid, { text: result.summary }, { quoted: m });
            } else {
              await maybeChatReply(m, text, sender);
            }
            if (result.changes > 0) enqueueHere(proposeForReviewItems); // runs after this message, never alongside
          } catch (err) {
            console.error("    ✗ Could not process:", err instanceof Error ? err.message : err);
            return; // keep the cursor so it is retried next time
          }
        }
        await saveCursor(ts);
      });
    }
  });
}

/**
 * AI worker: proposes a shop for every item in "Needs review" that the AI hasn't
 * looked at yet (from WhatsApp or the web page). Runs every 15 seconds.
 */
async function proposeForReviewItems(): Promise<void> {
  if (!family || !aiReady || aiBusy) return;
  aiBusy = true;
  try {
    const fid = family.id;
    const { data: pending } = await db.from("items").select("id, name")
      .eq("family_id", fid).eq("status", "needed").is("shop_id", null).is("proposed_at", null)
      .order("created_at").limit(10);
    if (!pending?.length) return;

    const [shopsRes, rulesRes] = await Promise.all([
      db.from("shops").select("id, name, categories, example_items, notes").eq("family_id", fid).order("priority"),
      db.from("rules").select("item_name, shop_id").eq("family_id", fid).order("created_at", { ascending: false }).limit(60),
    ]);
    const shops: AiShop[] = shopsRes.data ?? [];
    if (shops.length === 0) return;
    const sameThings = groupList(await loadSynonyms());
    const shopName = new Map(shops.map((s) => [s.id, s.name]));
    const past = (rulesRes.data ?? [])
      .filter((r) => shopName.has(r.shop_id))
      .map((r) => ({ item: r.item_name, shop: shopName.get(r.shop_id)! }));

    for (const item of pending) {
      const started = Date.now();
      const p = await proposeShop(item.name, shops, past, sameThings);
      await db.from("items").update({
        proposed_shop_id: p.shopId,
        proposal_confidence: p.confidence,
        proposal_reason: p.isItem ? p.reason : `May not be a shopping item. ${p.reason}`.trim(),
        proposed_at: new Date().toISOString(),
      }).eq("id", item.id);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`    AI: ${item.name} → ${p.isItem ? (p.shopId ? shopName.get(p.shopId) : "no idea") : "not an item?"}` +
        ` (${Math.round(p.confidence * 100)}%, ${secs}s) ${p.reason}`);
    }
  } catch (err) {
    console.error("    AI worker error:", err instanceof Error ? err.message : err);
    aiReady = false; // re-checked below
  } finally {
    aiBusy = false;
  }
}

/** Runs a background job once for each active group, switching context each time. */
async function forEachActiveGroup(job: () => Promise<void>): Promise<void> {
  const { data } = await db.from("families").select(GROUP_COLUMNS).eq("status", "active").not("whatsapp_group_jid", "is", null);
  for (const g of (data ?? []) as GroupRow[]) {
    useGroup(g);
    await job();
  }
}

async function backgroundAiWork(): Promise<void> {
  await forEachActiveGroup(async () => {
    await processQueuedMessages();
    await proposeForReviewItems();
  });
}

async function startAiWorker(): Promise<void> {
  const check = await checkOllama();
  aiReady = check.ok;
  console.log(`${check.ok ? "✓" : "!"} ${check.message}${check.ok ? "" : " Items will wait in Needs review without suggestions."}`);
  // Background AI work, every 15s, only when nothing else is in the line.
  setInterval(() => {
    if (waiting === 0) enqueue(backgroundAiWork);
  }, 15_000);
  setInterval(async () => {
    if (!aiReady && (await checkOllama()).ok) {
      aiReady = true;
      napNotified = false;
      console.log("✓ Local AI is back; processing parked messages");
    }
  }, 60_000);
  enqueue(backgroundAiWork);
  // Groups that never gave the magic word: leave after 24 hours.
  setInterval(() => enqueue(leaveExpiredGroups), 10 * 60_000);
}

startAiWorker().then(connect).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
