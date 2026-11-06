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
import { normalise } from "../lib/matching";
import { chatReply, checkOllama, extractActions, guessShopItems, proposeShop, readList, readShopAnswer, toEnglish } from "../lib/ai";
import { generateToken, looksLikeCode, normaliseCode, sha256Hex } from "../lib/codes";
import { handleMessage, maybeStartOnboarding, processQueuedMessages, proposeForReviewItems } from "../lib/bot/core";
import type { Bot, BotAi, BotChat, BotState, IncomingMessage } from "../lib/bot/ports";
import { supabaseStore } from "./bot-supabase";

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

type Sock = ReturnType<typeof makeWASocket>;
let currentSock: Sock | null = null; // for reacting to queued messages later
/** Shared across groups: is the local AI up, has the group been told it's napping, is it busy. */
const botState: BotState = { aiReady: false, napNotified: false, aiBusy: false };

const ollama: BotAi = {
  toEnglish: (text, keep) => toEnglish(text, keep),
  extractActions: (text) => extractActions(text),
  chatReply: (text, sender, ctx) => chatReply(text, sender, ctx),
  proposeShop: (item, shops, past, same) => proposeShop(item, shops, past, same),
  readList: (kind, text) => readList(kind, text),
  readShopAnswer: (text) => readShopAnswer(text),
  guessShopItems: (shop) => guessShopItems(shop),
};

/**
 * The shared message handling (lib/bot/core.ts) for the current group: Supabase for
 * data, this WhatsApp connection for sending, Ollama for the AI.
 */
function botForCurrentGroup(): Bot {
  const fid = family!.id, jid = groupJid!;
  const chat: BotChat = {
    async send(text, quote) {
      if (!currentSock) return null;
      const sent = await currentSock.sendMessage(jid, { text }, quote ? { quoted: quote.ref as WAMessage } : undefined);
      return sent?.key.id ?? null;
    },
    async react(msg, emoji) {
      const key = (msg.ref as WAMessage | undefined)?.key ?? (msg.ref as WAMessage["key"]);
      if (currentSock && key) { await currentSock.sendMessage(jid, { react: { text: emoji, key } }); }
    },
  };
  return {
    store: supabaseStore(db, fid),
    chat,
    ai: ollama,
    state: botState,
    log: (line) => console.log(`    ${line}`),
    pause: async (min, max) => { await sleep(min + Math.random() * (max - min)); },
    afterChange: () => enqueueHere(() => proposeForReviewItems(botForCurrentGroup())),
    now: () => new Date(),
  };
}

/** A WhatsApp group message in the shape the shared handling uses. */
function incoming(m: WAMessage, text: string, sender: string): IncomingMessage {
  const inner = m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message;
  const ctx = inner?.extendedTextMessage?.contextInfo;
  const quotedFrom = ctx?.quotedMessage ? ctx.participant : null;
  const mentioned = ctx?.mentionedJid ?? [];
  return {
    id: m.key.id!,
    text,
    sender,
    quotedId: ctx?.stanzaId ?? null,
    quotedFrom: quotedFrom ? (isBot(quotedFrom) ? "bot" : "other") : null,
    mentionsBot: mentioned.some(isBot),
    mentionsOthers: mentioned.some((j) => !isBot(j)),
    ref: m,
  };
}

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

// ---------------------------------------------------------------------------
// Groups: every WhatsApp group the bot is in is its own shopping group

async function groupByJid(jid: string): Promise<GroupRow | null> {
  const { data } = await db.from("families").select(GROUP_COLUMNS).eq("whatsapp_group_jid", jid).maybeSingle();
  return (data as GroupRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Who added the bot: shown on All groups so the super user knows who to send the magic word to

type Meta = { owner?: string; ownerJid?: string; participants?: { id: string; jid?: string; lid?: string; notify?: string; name?: string }[] };

/**
 * A WhatsApp id as a phone number ("447700900123"), or null. Newer groups use anonymous
 * "lid" ids, so the group's member list is used to find the matching phone id.
 */
async function phoneOf(sock: Sock, jid: string | undefined | null, meta?: Meta | null): Promise<{ number: string | null; name: string | null }> {
  if (!jid) return { number: null, name: null };
  const p = meta?.participants?.find((x) => x.id === jid || x.lid === jid || x.jid === jid);
  let phoneJid = jid.endsWith("@s.whatsapp.net") ? jid : p?.jid?.endsWith("@s.whatsapp.net") ? p.jid : p?.id.endsWith("@s.whatsapp.net") ? p.id : null;
  if (!phoneJid && jid.endsWith("@lid")) {
    // Baileys keeps a lid -> phone map; its shape differs between versions, so look it up carefully.
    const repo = (sock as unknown as { signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } } }).signalRepository;
    phoneJid = (await repo?.lidMapping?.getPNForLID?.(jid).catch(() => null)) ?? null;
  }
  const number = phoneJid ? idNumber(phoneJid) : null;
  return { number: number && /^\d{6,15}$/.test(number) ? number : null, name: p?.notify || p?.name || null };
}

/** Saves who added the bot (from the "added" event) and who created the group (from its details). */
async function recordWhoAdded(sock: Sock, groupJid: string, authorJid: string | undefined | null, meta?: Meta | null): Promise<string | null> {
  try {
    const m = meta ?? ((await sock.groupMetadata(groupJid).catch(() => null)) as Meta | null);
    const update: Record<string, string | null> = {};
    if (authorJid && !isBot(authorJid)) {
      const who = await phoneOf(sock, authorJid, m);
      if (who.number) { update.added_by_number = who.number; update.added_by_name = who.name; }
    }
    const creator = await phoneOf(sock, m?.ownerJid ?? m?.owner, m);
    if (creator.number) { update.created_by_number = creator.number; update.created_by_name = creator.name; }
    if (Object.keys(update).length === 0) return null;
    await db.from("families").update(update).eq("whatsapp_group_jid", groupJid);
    if (update.added_by_number) console.log(`  added by +${update.added_by_number}${update.added_by_name ? ` (${update.added_by_name})` : ""}`);
    return update.added_by_number ?? update.created_by_number ?? null;
  } catch (err) {
    console.error("  ✗ could not record who added the bot:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invites: someone the super user invited by number needs no magic word

type InviteRow = { id: string; name: string; number: string };

/** A live invite (not used, cancelled or expired) for one of these numbers. */
async function liveInvite(numbers: (string | null | undefined)[]): Promise<InviteRow | null> {
  const nums = [...new Set(numbers.filter((n): n is string => !!n))];
  if (nums.length === 0) return null;
  const { data } = await db.from("invites").select("id, name, number")
    .in("number", nums).is("used_at", null).is("cancelled_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1);
  return (data?.[0] as InviteRow | undefined) ?? null;
}

/**
 * A pending group added (or created) by an invited number: switch it on straight away,
 * spend the invite, and send the setup link to the invited person. True if it did.
 */
async function activateIfInvited(sock: Sock, g: GroupRow): Promise<boolean> {
  const { data: who } = await db.from("families").select("added_by_number, created_by_number").eq("id", g.id).maybeSingle();
  const invite = await liveInvite([who?.added_by_number, who?.created_by_number]);
  if (!invite) return false;
  // Spend the invite first, so it can never set up two groups.
  const { data: spent } = await db.from("invites").update({ used_at: new Date().toISOString(), family_id: g.id })
    .eq("id", invite.id).is("used_at", null).select("id");
  if (!spent?.length) return false;
  console.log(`✓ "${g.name}" was added by invited ${invite.name}; no magic word needed`);
  await switchOn(sock, g, {
    personJid: `${invite.number}@s.whatsapp.net`,
    personName: invite.name,
    groupText: (dm) => `✅ Hi ${invite.name}, you were invited, so no magic word is needed. ShoppingSync is on for this group.` +
      (dm ? " I've sent you a private link to set up this group's web page." : " Ask for a setup link for this group's web page.") +
      ` Send "help" to see what I can do.`,
  });
  return true;
}

/** Pending groups whose invite was created after the bot joined: checked every few minutes. */
async function activateInvitedGroups(): Promise<void> {
  if (!currentSock) return;
  const { data } = await db.from("families").select(GROUP_COLUMNS).eq("status", "pending").not("whatsapp_group_jid", "is", null);
  for (const g of (data ?? []) as GroupRow[]) await activateIfInvited(currentSock, g);
}

/** The bot's own number, for the Use me page (shown only to people with an invite). */
async function shareBotNumber(sock: Sock): Promise<void> {
  const number = idNumber(sock.user?.id);
  if (!/^\d{8,15}$/.test(number)) return;
  await db.from("app_settings").upsert({ key: "bot_number", value: number, updated_at: new Date().toISOString() });
}

/** Fills in the WhatsApp names of whoever added the bot / created the group, once they send a message. */
async function learnNames(g: GroupRow, senderNumber: string, name: string): Promise<void> {
  if (!senderNumber || !name || name === "WhatsApp") return;
  await db.from("families").update({ added_by_name: name }).eq("id", g.id).eq("added_by_number", senderNumber).is("added_by_name", null);
  await db.from("families").update({ created_by_name: name }).eq("id", g.id).eq("created_by_number", senderNumber).is("created_by_name", null);
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
async function ensureGroup(jid: string, subject: string, added?: { author?: string | null; meta?: Meta | null }): Promise<GroupRow | null> {
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
    await recordWhoAdded(sock, jid, added?.author, added?.meta);
    if (!(await activateIfInvited(sock, g))) await sendPrompt(sock, g);
    return groupByJid(jid);
  }

  if (g.status === "inactive" || g.status === "left") {
    await db.from("families").update({ status: "pending", prompt_message_id: null, prompt_sent_at: null }).eq("id", g.id);
    console.log(`+ re-added to "${g.name}"`);
    await recordWhoAdded(sock, jid, added?.author, added?.meta);
    const again = { ...g, status: "pending" as const };
    if (!(await activateIfInvited(sock, again))) await sendPrompt(sock, again);
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
  for (const meta of groups) {
    const g = await ensureGroup(meta.id, meta.subject, { meta: meta as Meta });
    if (g?.status === "pending") await recordWhoAdded(sock, meta.id, null, meta as Meta);
  }
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
  await activateInvitedGroups();
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
  await switchOn(sock, g, {
    personJid: senderJid, personName: sender, quoted: m, ts,
    groupText: (dm) => `✅ Magic word accepted. ShoppingSync is on for this group.` +
      (dm ? ` ${sender}, I've sent you a private link to set up this group's console.` : " The super user can send a console setup link.") +
      ` Send "help" to see what I can do.`,
  });
}

/**
 * Switches a group on (after a magic word or an invite): marks it active, starts reading
 * from now, privately sends the person a one-time setup link, and tells the group.
 */
async function switchOn(sock: Sock, g: GroupRow, opts: {
  personJid: string; personName: string; groupText: (dmSent: boolean) => string; quoted?: WAMessage; ts?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  await db.from("families").update({ status: "active", activated_at: now, activated_by: opts.personJid, activated_by_name: opts.personName }).eq("id", g.id);
  cursors.set(g.id, ts);
  await db.from("sync_state").update({ message_cursor: String(ts), last_synced_at: now }).eq("family_id", g.id);
  console.log(`✓ "${g.name}" is now active`);

  // A private, one-time link for this group's console login, sent only to this person.
  const token = generateToken();
  await db.from("setup_tokens").insert({
    family_id: g.id, token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + SETUP_LINK_TTL_MS).toISOString(),
  });
  let dmSent = false;
  if (opts.personJid) {
    try {
      await sock.sendMessage(opts.personJid, {
        text: `Here's your one-time link to set up the ShoppingSync console for "${g.name}":\n${BASE_URL}/setup?t=${token}\n\nIt works once and expires in 48 hours.`,
      });
      dmSent = true;
    } catch (err) {
      console.error("    ✗ could not send the setup link privately:", err instanceof Error ? err.message : err);
    }
  }
  await sock.sendMessage(g.whatsapp_group_jid!, { text: opts.groupText(dmSent) }, opts.quoted ? { quoted: opts.quoted } : undefined);

  // A brand-new group with no shops: ask a few setup questions right here in WhatsApp.
  useGroup({ ...g, status: "active" });
  await maybeStartOnboarding(botForCurrentGroup());
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
      enqueue(() => shareBotNumber(sock));
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
    for (const g of groups) enqueue(async () => { await ensureGroup(g.id, g.subject, { author: g.author, meta: g as Meta }); });
  });
  // Added to or removed from a group while running.
  sock.ev.on("group-participants.update", ({ id, author, participants, action }) => {
    const ids = (participants as unknown[]).map((p) => (typeof p === "string" ? p : (p as { id?: string }).id ?? ""));
    if (!ids.some(isBot)) return;
    enqueue(async () => {
      if (action === "remove") {
        await db.from("families").update({ status: "inactive" }).eq("whatsapp_group_jid", id).in("status", ["active", "pending"]);
        console.log(`− removed from group ${id}; marked inactive (its data is kept)`);
      } else if (action === "add") {
        const meta = await sock.groupMetadata(id).catch(() => null);
        await ensureGroup(id, meta?.subject ?? "WhatsApp group", { author, meta: meta as Meta | null });
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
          const senderNumber = idNumber((m.key as { participantPn?: string }).participantPn ?? m.key.participant);
          await learnNames(g, senderNumber, sender).catch(() => undefined);
          if (await activateIfInvited(sock, g)) return;
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
            // The same handling as the demo page: lib/bot/core.ts
            await handleMessage(botForCurrentGroup(), incoming(m, text, sender));
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
    await processQueuedMessages(botForCurrentGroup());
    await proposeForReviewItems(botForCurrentGroup());
  });
}

async function startAiWorker(): Promise<void> {
  const check = await checkOllama();
  botState.aiReady = check.ok;
  console.log(`${check.ok ? "✓" : "!"} ${check.message}${check.ok ? "" : " Items will wait in Needs review without suggestions."}`);
  // Background AI work, every 15s, only when nothing else is in the line.
  setInterval(() => {
    if (waiting === 0) enqueue(backgroundAiWork);
  }, 15_000);
  setInterval(async () => {
    if (!botState.aiReady && (await checkOllama()).ok) {
      botState.aiReady = true;
      botState.napNotified = false;
      console.log("✓ Local AI is back; processing parked messages");
    }
  }, 60_000);
  enqueue(backgroundAiWork);
  // Groups that never gave the magic word: leave after 24 hours.
  setInterval(() => enqueue(leaveExpiredGroups), 10 * 60_000);
  // Invites created after the bot joined a group: switch those groups on.
  setInterval(() => enqueue(activateInvitedGroups), 2 * 60_000);
}

startAiWorker().then(connect).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
