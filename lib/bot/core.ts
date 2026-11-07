/**
 * How the bot handles a message in an active group: commands, lists, sentences,
 * translations, questions and answers. Used by the WhatsApp listener and by the
 * demo page, so both behave exactly the same. Everything outside (database, chat,
 * AI) comes in through `bot` (see ports.ts).
 */
import { parseMessageDetailed, type ParsedAction } from "../parse";
import {
  buildSynonymGroups, findFamilyWord, groupList, isKnownItem, normalise, onlyKnownWords, sameItem, splitKnownWords,
  suggestShop, type KnownItems, type SynonymGroups,
} from "../matching";
import { tidyShopName, type AiShop, type ExtractedActions, type WindowReading } from "../ai";
import { formatListMessage, isListRequest } from "../format";
import { addToWindow, closeWindow, currentWindow, looksLikeQuestion, noteBotLine, updateQuestions } from "./window";
import { formatReview, formatSummary, HELP_TEXT, isHelpRequest, isReviewRequest, isSummaryRequest, startOfTodayUk } from "../info";
import { matchShopName, parseAddShop, parseDone, parseReplace, parseSynonyms, parseTanglishMeans } from "../commands";
import { planReplace, type ReplaceItem } from "../replace";
import type { Bot, BotItem, IncomingMessage, Preference, QuestionInput, SynonymPairInput } from "./ports";
import { handleOnboarding, maybeStartOnboarding, setupQuestionText } from "./onboarding";

/** "no thanks", "ok cool", "yes please", "nope, all good": a reply, never an item. */
const CHAT_REPLY = /^(?:no|nope|nah|yes|yeah|yep|yup|ok|okay|sure|cool|great|fine)[\s,!.]*(?:thanks|thank you|thx|cheers|please|pls|worries|problem|all good|it'?s fine|that'?s fine|we'?re (?:fine|good|ok)|mate|then|cool|great)?[\s!.👍🙏]*$/iu;

/** "no eggs", "no more milk": the family is out of it, or doesn't want it. Never an item called "no eggs". */
const NO_ITEM = /^(?:no|no more|nope,?\s+no|zero)\s+\p{L}/iu;

const QUESTION_TTL_MS = 24 * 3600 * 1000;      // unanswered questions expire after a day
const BARE_ANSWER_WINDOW_MS = 30 * 60 * 1000;  // a plain "yes" (not a reply) counts for 30 minutes

export const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const bold = (x: string) => `*${x}*`;
const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);
const reply = (bot: Bot) => bot.pause(800, 2000);

type Reading = { actions: ParsedAction[]; preferences: Preference[]; fromAi: boolean; parked?: boolean; synonyms?: SynonymPairInput[] };

// ---------------------------------------------------------------------------
// The message pipeline

/** Every command the bot recognises as written, without the AI. */
export function isCommand(text: string): boolean {
  return isListRequest(text) || isHelpRequest(text) || isSummaryRequest(text) || isReviewRequest(text) || !!parseAddShop(text) || !!parseDone(text) ||
    !!parseAnswer(text) || !!parseSynonyms(text) || !!parseReplace(text) || !!parseTanglishMeans(text);
}

/**
 * Handles one text message. Throws if something failed part-way (the listener then
 * leaves the message to be retried).
 *  - while the setup chat is open, messages are its answers (see onboarding.ts)
 *  - a group with no shops that was never set up is offered the setup chat afterwards
 */
/** Adds items for the setup chat (it reports what it added in its own words). */
const addItemsWith = (bot: Bot) => async (actions: ParsedAction[], msg: IncomingMessage) => {
  const r = await applyActions(bot, actions, msg.sender, msg.id);
  if (r.changes > 0) bot.afterChange();
  return r;
};

export async function handleMessage(bot: Bot, m: IncomingMessage): Promise<void> {
  if (!(await handleOnboarding(bot, m, addItemsWith(bot)))) {
    await handleText(bot, m);
    await maybeStartOnboarding(bot);
  }
  // Keeps the window tidy: e.g. unanswered questions go once this message cleared the list.
  await currentWindow(bot);
}

async function handleText(bot: Bot, m: IncomingMessage): Promise<void> {
  const { text, sender } = m;
  // Other languages: translate to English first, then handle exactly like English.
  // Commands and yes/no answers are recognised as they are, without the AI.
  let english = text;
  let unsure = false; // an unsure translation is shown to the family and confirmed before anything changes
  const command = isCommand(text);
  const synonyms = command ? null : await loadSynonyms(bot);
  const ruleReading = command ? null : parseMessageDetailed(text);
  const plainChat = !!ruleReading && ((!ruleReading.needsAi && ruleReading.actions.length === 0) || CHAT_REPLY.test(text.trim())); // "ok", 👍, "no thanks"
  // A clear list of 2+ items keeps its shape: items are translated one by one, never the whole message.
  let listShape = !!ruleReading && !ruleReading.needsAi && ruleReading.actions.length >= 2 ? ruleReading.actions : null;
  // "pal coffee", "milk eggs bread": split on spaces only when EVERY piece is something the list knows.
  const known = synonyms && ruleReading && !ruleReading.needsAi ? await loadKnownItems(bot, synonyms) : undefined;
  if (!listShape && known && ruleReading?.actions.length) {
    const split = ruleReading.actions.flatMap((a) => {
      const parts = splitKnownWords(a.name, known);
      if (!parts) return [a];
      return parts.map((name, i): ParsedAction =>
        a.kind === "add" ? { kind: "add", name, quantity: i === 0 ? a.quantity : null } : { kind: a.kind, name });
    });
    if (split.length >= 2) {
      listShape = split;
      bot.log(`split into known items: ${split.map((a) => a.name).join(", ")}`);
    }
  }
  let listActions: ParsedAction[] | null = null;
  if (plainChat) {
    bot.log("rules: ordinary chat, nothing to do");
  } else if (listShape && synonyms) {
    bot.log(`rules: a list of ${listShape.length} items`);
    listActions = await translateListItems(bot, listShape, synonyms, known);
    if (!listActions) return parkMessage(bot, m);
  } else if (!command && synonyms && onlyKnownWords(text, synonyms)) {
    bot.log("only family words; no translation needed");
  } else if (!command) {
    let translated = false;
    if (bot.state.aiReady) {
      try {
        const t = await bot.ai.toEnglish(text, [...(synonyms?.keys() ?? [])]);
        translated = true;
        if (t.language !== "English") {
          english = t.english;
          unsure = t.confidence < 0.7;
          bot.log(`AI translated from ${t.language} (${Math.round(t.confidence * 100)}% sure): ${english}`);
        } else {
          bot.log("AI: already English");
        }
      } catch (err) {
        bot.state.aiReady = false;
        bot.log(`AI unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!translated) return parkMessage(bot, m);
  } else {
    bot.log("rules: a command");
  }

  if (isListRequest(english)) {
    await reply(bot);
    const list = await buildListMessage(bot);
    const sentId = await bot.chat.send(list.text, m);
    if (sentId) await bot.store.rememberList(sentId, list.itemIds);
    bot.log(`→ sent the shopping list (${list.itemIds.length} items)`);
    return;
  }
  if (isHelpRequest(english)) {
    await reply(bot);
    await bot.chat.send(HELP_TEXT, m);
    bot.log("→ sent help");
    return;
  }
  if (isSummaryRequest(english)) {
    const data = await bot.store.summaryItems(startOfTodayUk(bot.now()).toISOString());
    await reply(bot);
    await bot.chat.send(formatSummary(data, bot.now()), m);
    bot.log("→ sent today's summary");
    return;
  }
  if (isReviewRequest(english)) {
    const review = (await bot.store.neededItems()).filter((i) => !i.shop_id).map((i) => i.name);
    await reply(bot);
    await bot.chat.send(formatReview(review, bot.reviewUrl), m);
    bot.log(`→ sent the review link (${review.length} waiting)`);
    return;
  }
  const replace = parseReplace(english);
  if (replace) return handleReplace(bot, m, replace.from, replace.to);
  const synonymPairs = parseSynonyms(english);
  if (synonymPairs) {
    if (unsure) await askToConfirm(bot, m, { actions: [], preferences: [], synonyms: synonymPairs }, english);
    else await handleSynonyms(bot, synonymPairs);
    return;
  }
  // Tanglish "riz na rice": recognised by the app, but always confirmed ("na" can mean "don't").
  const tanglishPair = parseTanglishMeans(text);
  if (tanglishPair) {
    const groups = await loadSynonyms(bot);
    if (sameItem(normalise(tanglishPair.a), normalise(tanglishPair.b), groups)) {
      await reply(bot);
      await bot.chat.send(`${tanglishPair.a} and ${tanglishPair.b} are already the same.`, m);
    } else {
      await askToConfirm(bot, m, { actions: [], preferences: [], synonyms: [tanglishPair] });
    }
    return;
  }
  const addShop = parseAddShop(english);
  if (addShop) return handleAddShop(bot, addShop.name, addShop.exampleItems);
  const answer = parseAnswer(english);
  // "No" while people are talking answers them, not the bot (unless it replies to the bot).
  if (answer && m.quotedFrom !== "bot" && (await currentWindow(bot))) return readContext(bot, m, english);
  if (answer && (await handleAnswer(bot, answer, sender, m.quotedId))) return;
  const done = parseDone(english);
  if (done) return handleDone(bot, done.shop, m.quotedId, sender);

  // "no thanks", "nope, all good": a reply to someone, never an item.
  if (!listActions && CHAT_REPLY.test(english.trim())) {
    if (await currentWindow(bot)) return readContext(bot, m, english);
    bot.log("(a reply, nothing to do)");
    return;
  }
  // Not a clear action (a question, a sentence, "no eggs"): it goes to the context window.
  if (!listActions && !unsure && (parseMessageDetailed(english).needsAi || NO_ITEM.test(english.trim()))) {
    bot.log("not a clear action: into the context window");
    return readContext(bot, m, english);
  }
  const reading: Reading = listActions
    ? { actions: listActions, preferences: [], fromAi: false }
    : await readMessage(bot, english);
  if (reading.parked) return parkMessage(bot, m);
  if (reading.fromAi || unsure) {
    // an unsure translation is confirmed first
    await askToConfirm(bot, m, reading, unsure ? english : undefined);
    return;
  }
  // "almond flour from Costco": a shop the family already has is used straight away;
  // one they don't have yet is asked about first ("Costco isn't one of your shops yet").
  const { ready, unknownShop } = await sortByShop(bot, reading.actions);
  const result = await applyActions(bot, ready, sender, m.id);
  if (result.summary) {
    await reply(bot); // a human-like pause before replying
    await bot.chat.send(result.summary, m);
  }
  if (unknownShop.length) await askToConfirm(bot, m, { actions: unknownShop, preferences: [] });
  else if (!result.summary && result.changes === 0) {
    // A question opens the context window; "ok", "lol", "No" join one that's already open.
    if (looksLikeQuestion(english) || (await currentWindow(bot))) await readContext(bot, m, english);
    else bot.log("(nothing to do)");
  }
  if (result.changes > 0) bot.afterChange();
}

/**
 * Splits actions by whether the shop they name ("from Costco") is one of the family's shops.
 * A name that is a family member ("flowers from Bob") isn't a shop: the shop is dropped.
 */
async function sortByShop(bot: Bot, actions: ParsedAction[]): Promise<{ ready: ParsedAction[]; unknownShop: ParsedAction[] }> {
  if (!actions.some((a) => a.kind === "add" && a.shop)) return { ready: actions, unknownShop: [] };
  const [shops, members] = await Promise.all([bot.store.shops(), bot.store.members()]);
  const ready: ParsedAction[] = [], unknownShop: ParsedAction[] = [];
  for (const a of actions) {
    if (a.kind !== "add" || !a.shop) { ready.push(a); continue; }
    if (members.some((n) => normalise(n) === normalise(a.shop!))) { ready.push({ kind: "add", name: a.name, quantity: a.quantity }); continue; }
    (matchShopName(a.shop, shops).kind === "none" ? unknownShop : ready).push(a);
  }
  if (unknownShop.length) bot.log(`not one of the shops yet: ${[...new Set(unknownShop.map((a) => (a as { shop: string }).shop))].join(", ")}`);
  return { ready, unknownShop };
}

/** Creates the shops that confirmed actions name but the family doesn't have yet ("Costco"). Returns their names. */
async function createNamedShops(bot: Bot, actions: ParsedAction[]): Promise<string[]> {
  const created: string[] = [];
  for (const a of actions) {
    if (a.kind !== "add" || !a.shop) continue;
    const shops = await bot.store.shops();
    if (namedShop(a.shop, shops)) continue;
    const priority = Math.max(100, ...shops.map((s) => s.priority)) + 10;
    const shop = await bot.store.addShop({ name: tidyShopName(a.shop), example_items: [], priority });
    if (shop) { created.push(shop.name); bot.log(`+ shop ${shop.name}`); }
  }
  return created;
}

/** The shop an action names, if it's one of the family's shops. */
function namedShop<S extends { id: string; name: string }>(said: string | undefined, shops: S[]): S | null {
  if (!said) return null;
  const match = matchShopName(said, shops);
  if (match.kind === "one") return match.shop;
  if (match.kind === "several") return match.shops.find((s) => normalise(s.name) === normalise(said)) ?? match.shops[0];
  return null;
}

// ---------------------------------------------------------------------------
// Reading

async function loadSynonyms(bot: Bot): Promise<SynonymGroups> {
  return buildSynonymGroups(await bot.store.synonymPairs());
}

/** Everything this group's list already knows: rules, shops' example items and synonyms. */
async function loadKnownItems(bot: Bot, groups: SynonymGroups): Promise<KnownItems> {
  const [rules, shops] = await Promise.all([bot.store.rules(), bot.store.shops()]);
  return { rules, shops, groups };
}

/**
 * A clear list ("pal,coffee", "milk and eggs", one per line) keeps its shape:
 * each item is translated on its own, so translation can never join or drop items.
 * Family words ("pal") are kept as typed. Returns null if an item needs the AI
 * and the AI is off (the message is then parked).
 */
async function translateListItems(bot: Bot, actions: ParsedAction[], groups: SynonymGroups, known?: KnownItems): Promise<ParsedAction[] | null> {
  const out: ParsedAction[] = [];
  for (const a of actions) {
    if (findFamilyWord(a.name, groups) || onlyKnownWords(a.name, groups) || (known && isKnownItem(a.name, known))) { out.push(a); continue; }
    if (!bot.state.aiReady) return null;
    try {
      const t = await bot.ai.toEnglish(a.name, [...groups.keys()]);
      if (t.language !== "English" && t.english && t.english.toLowerCase() !== a.name.toLowerCase()) {
        bot.log(`AI: item translated from ${t.language}: ${a.name} → ${t.english}`);
        out.push({ ...a, name: t.english });
      } else {
        out.push(a);
      }
    } catch (err) {
      bot.state.aiReady = false;
      bot.log(`AI unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  return out;
}

/** The AI's reading of a message, in the same shape the rules produce. */
function toActions(ex: ExtractedActions): ParsedAction[] {
  return [
    ...ex.add.map((a) => ({ kind: "add" as const, name: a.name, quantity: a.quantity, ...(a.shop ? { shop: a.shop } : {}) })),
    ...ex.bought.map((name) => ({ kind: "bought" as const, name })),
    ...ex.remove.map((name) => ({ kind: "remove" as const, name })),
  ];
}

/**
 * Works out what a message asks for. Short lists are read by the rules;
 * sentences are read by the AI. If the AI is unavailable the message is
 * queued and handled when it is back, so nothing is lost.
 */
async function readMessage(bot: Bot, text: string): Promise<Reading> {
  const parsed = parseMessageDetailed(text);
  if (!parsed.needsAi) {
    bot.log(parsed.actions.length ? `rules read: ${parsed.actions.map((a) => `${a.kind} ${a.name}`).join(", ")}` : "rules: nothing to do");
    return { actions: parsed.actions, preferences: [], fromAi: false };
  }
  bot.log("reads like a sentence: asking the AI");
  if (bot.state.aiReady) {
    try {
      const ex = await bot.ai.extractActions(text);
      const actions = toActions(ex);
      const said = [...actions.map((a) => `${a.kind} ${a.name}`), ...ex.preferences.map((p) => `prefer ${p.item} at ${p.shop}`)];
      bot.log(`AI read: ${said.length ? said.join(", ") : "no shopping items"}`);
      return { actions, preferences: ex.preferences, fromAi: true };
    } catch (err) {
      bot.state.aiReady = false;
      bot.log(`AI unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { actions: [], preferences: [], fromAi: false, parked: true };
}

// ---------------------------------------------------------------------------
// Messages that aren't shopping actions

/**
 * Adds the message to the context window and has the AI read the window as one
 * conversation. Whatever it finds is asked about first (never acted on directly);
 * a question about the list is answered from the list itself.
 */
async function readContext(bot: Bot, m: IncomingMessage, english: string): Promise<void> {
  if (!bot.state.aiReady) return parkMessage(bot, m);
  const w = await addToWindow(bot, {
    id: m.id, sender: m.sender, text: english === m.text ? m.text : `${m.text} (in English: ${english})`, at: bot.now().toISOString(),
    replyTo: m.quotedFrom, toBot: m.quotedFrom === "bot" || m.mentionsBot || /\b(?:shoppingsync|shopping\s*sync)\b/i.test(m.text),
  });
  bot.log(`context window: ${w.messages.length} message${w.messages.length === 1 ? "" : "s"}; asking the AI`);
  const [members, shops, needed, setupQuestion] = await Promise.all([
    bot.store.members(), bot.store.shops(), bot.store.neededItems(), setupQuestionText(bot),
  ]);
  const questions = (w.questions ?? []).filter((q) => q.id !== m.id);
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  let r: WindowReading;
  try {
    r = await bot.ai.readWindow({
      messages: w.messages.map((x) => ({
        from: x.sender, text: x.text, to_bot: x.toBot,
        replies_to: x.replyTo === "bot" ? "the bot" : x.replyTo === "other" ? "someone else" : null,
      })),
      members,
      setup_question: setupQuestion,
      list: needed.map((i) => ({ item: i.name, shop: (i.shop_id && shopName.get(i.shop_id)) || "Needs review" })),
      unanswered_questions: questions.map((q) => ({ id: q.id, from: q.sender, text: q.text, asked: whenSaid(q.at, bot.now()) })),
    });
  } catch (err) {
    bot.state.aiReady = false;
    bot.log(`AI unavailable: ${err instanceof Error ? err.message : err}`);
    return parkMessage(bot, m);
  }
  const actions = toActions(r);
  const said = [
    ...actions.map((a) => `${a.kind} ${a.name}`), ...r.preferences.map((p) => `prefer ${p.item} at ${p.shop}`),
    ...(r.list_question ? [`asks about ${r.list_question}`] : []),
    ...(r.setup_answer.kind !== "none" ? [`setup answer: ${r.setup_answer.kind} ${r.setup_answer.names.join(", ")}`] : []),
    ...(r.reply ? ["a reply"] : []),
    ...(r.answered.length ? [`answers ${r.answered.map((id) => `"${questions.find((q) => q.id === id)?.text ?? id}"`).join(", ")}`] : []),
    ...(r.track_question ? ["an open question"] : []),
  ];
  bot.log(`AI read the window: ${said.length ? said.join("; ") : "nothing to do yet"}`);
  // Questions: answered ones go; a new shopping question stays until it's answered or the list is cleared.
  const track = r.track_question && !r.reply && looksLikeQuestion(english);
  await updateQuestions(bot, r.answered.filter((id) => questions.some((q) => q.id === id)),
    track ? { id: m.id, sender: m.sender, text: m.text, at: bot.now().toISOString(), sawItems: needed.length > 0 } : null);

  const setup = r.setup_answer;
  if (setupQuestion && (setup.kind === "skip" || ((setup.kind === "shops" || setup.kind === "items") && setup.names.length))) {
    await closeWindow(bot, "an answer to the setup question");
    const text = setup.kind === "skip" ? "skip" : setup.names.join(", ");
    await handleOnboarding(bot, { ...m, text, quotedFrom: "bot", mentionsBot: true }, addItemsWith(bot));
    return;
  }
  if (actions.length || r.preferences.length) {
    await askToConfirm(bot, m, { actions, preferences: r.preferences }); // closes the window
    return;
  }
  const text = r.list_question ? await answerFromList(bot, r.list_question) : r.reply;
  if (!text) {
    bot.log("(nothing to do yet; the window stays open)");
    return;
  }
  await reply(bot);
  await bot.chat.send(text, m);
  await noteBotLine(bot, text);
  bot.log(r.list_question ? "💬 answered from the list" : "💬 replied");
}

/** "do we have eggs?": what the list knows about it. Never claims to know what's at home. */
async function answerFromList(bot: Bot, item: string): Promise<string> {
  const groups = await loadSynonyms(bot);
  const key = normalise(item);
  const same = (name: string, k: string) => sameItem(k, key, groups) || sameItem(normalise(name), key, groups);
  const [shops, needed] = await Promise.all([bot.store.shops(), bot.store.neededItems()]);
  const onList = needed.find((i) => same(i.name, i.item_key));
  if (onList) {
    const shop = shops.find((s) => s.id === onList.shop_id)?.name;
    const who = onList.requested_by[0] ? `, added by ${onList.requested_by[0]}` : "";
    return `🛒 *${onList.name}* is on the list${shop ? ` under ${shop}` : " (needs review)"}${who} ${whenSaid(onList.created_at, bot.now())}.`;
  }
  const since = new Date(bot.now().getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const got = (await bot.store.recentlyBought(since)).find((i) => same(i.name, i.item_key));
  if (got) return `✅ *${got.name}* was ticked off${got.bought_by ? ` by ${got.bought_by}` : ""} ${whenSaid(got.bought_at, bot.now())}.`;
  return `*${item}* isn't on the list. Send *${item}* to add it.`;
}

/** Saves the message for later and lets the group know. Nothing is guessed while the AI is off. */
async function parkMessage(bot: Bot, m: IncomingMessage): Promise<void> {
  await bot.store.park(m.id, { text: m.text, sender: m.sender, key: m.ref });
  bot.log("😴 parked until the AI is back");
  await reply(bot);
  if (!bot.state.napNotified) {
    bot.state.napNotified = true;
    await bot.chat.send("😴 The LLM is taking a nap, so this message is parked and will be processed later.", m);
  } else {
    await bot.chat.react(m, "💤");
  }
}

// ---------------------------------------------------------------------------
// Questions and answers

/** The shop a preference refers to: an existing shop if the name fits one, else a new shop name. */
function resolvePreferenceShop(said: string, shops: { id: string; name: string }[]): { id: string | null; name: string } {
  const match = matchShopName(said, shops);
  if (match.kind === "one") return match.shop;
  if (match.kind === "several") return match.shops.find((s) => normalise(s.name) === normalise(said)) ?? match.shops[0];
  return { id: null, name: said };
}

/** Asks the group to confirm what the AI read. Returns false if there was nothing to ask about. */
async function askToConfirm(
  bot: Bot, original: IncomingMessage | { sender: string; ref: unknown },
  reading: Pick<Reading, "actions" | "preferences" | "synonyms">,
  readAs?: string,   // set when an unsure translation is being checked: shown so the family sees the reading
): Promise<boolean> {
  const { actions, preferences } = reading;
  const synonymPairs = reading.synonyms ?? [];
  if (actions.length === 0 && preferences.length === 0 && synonymPairs.length === 0) {
    bot.log("(nothing to add)");
    return false;
  }
  // The bot is asking now, so the conversation so far is done with.
  await closeWindow(bot, "the bot asked a question");
  const shops = await bot.store.shops();
  const label = (a: ParsedAction) => bold(a.name) + (a.kind === "add" && a.quantity ? ` (${a.quantity})` : "");

  // An add plus a preference for the same thing reads as one step:
  // "add *Ramayana movie* under *iMax* (a new place)".
  const combined: string[] = [];
  const pairedAdds = new Set<ParsedAction>();
  const pairedPrefs = new Set<Preference>();
  for (const p of preferences) {
    const add = actions.find((a) => a.kind === "add" && normalise(a.name) === normalise(p.item) && !pairedAdds.has(a));
    if (!add) continue;
    const shop = resolvePreferenceShop(p.shop, shops);
    combined.push(`add ${label(add)} under ${bold(shop.name)}${shop.id ? "" : " (a new place)"}`);
    pairedAdds.add(add);
    pairedPrefs.add(p);
  }
  const adds = actions.filter((a) => a.kind === "add" && !pairedAdds.has(a) && !(a.kind === "add" && a.shop)).map(label);
  // Items named with a shop: "add milk under Waitrose", "add Costco as a place and put almond flour there"
  const byShop = new Map<string, ParsedAction[]>();
  for (const a of actions) {
    if (a.kind !== "add" || !a.shop || pairedAdds.has(a)) continue;
    const shop = namedShop(a.shop, shops);
    const key = shop ? shop.name : a.shop;
    byShop.set(key, [...(byShop.get(key) ?? []), a]);
  }
  const shopLines = [...byShop].map(([shopName, items]) => {
    const known = !!namedShop(shopName, shops);
    return known
      ? { text: `add ${andList(items.map(label))} under ${bold(shopName)}`, single: "" }
      : {
        text: `add ${bold(shopName)} as a place and put ${andList(items.map(label))} there`,
        single: `${shopName} isn't one of your shops yet. Reply *yes* to add ${bold(shopName)} and put ${andList(items.map(label))} there.`,
      };
  });
  const bought = actions.filter((a) => a.kind === "bought").map(label);
  const removed = actions.filter((a) => a.kind === "remove").map(label);
  const prefLines = preferences.filter((p) => !pairedPrefs.has(p)).map((p) => {
    const shop = resolvePreferenceShop(p.shop, shops);
    return shop.id
      ? { text: `always put ${bold(p.item)} on the ${bold(shop.name)} list`, single: `Shall I always put ${bold(p.item)} on the ${bold(shop.name)} list? Reply *yes* to confirm.` }
      : { text: `add ${bold(shop.name)} as a place and always put ${bold(p.item)} there`, single: `${shop.name} isn't one of your places yet. Reply *yes* to add ${bold(shop.name)} and always put ${p.item} there.` };
  });

  const lines = [
    ...combined,
    ...(adds.length ? [`add ${andList(adds)}`] : []),
    ...shopLines.map((l) => l.text),
    ...(bought.length ? [`tick off ${andList(bought)}`] : []),
    ...(removed.length ? [`remove ${andList(removed)}`] : []),
    ...prefLines.map((p) => p.text),
    ...synonymPairs.map((p) => `save ${bold(p.a)} = ${bold(p.b)}`),
  ];
  let text: string;
  if (prefLines.length === 1 && lines.length === 1) text = prefLines[0].single;
  else if (shopLines.length === 1 && lines.length === 1 && shopLines[0].single) text = shopLines[0].single;
  else if (adds.length && lines.length === 1) text = `I'll add ${andList(adds)} to the list. Reply *yes* to confirm, or *no* to skip.`;
  else if (lines.length === 1) text = `Shall I ${lines[0]}? Reply *yes* to confirm, or *no* to skip.`;
  else text = `From that message, shall I:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nReply *yes* to confirm, or *no* to skip.`;
  if (readAs) text = `I read that as "${readAs}". ${text}`;

  await reply(bot);
  const sentId = await bot.chat.send(text);
  if (!sentId) return false;
  const input: QuestionInput = { actions, preferences, synonyms: synonymPairs, sender: original.sender, key: original.ref, askedAt: bot.now().toISOString() };
  await bot.store.addQuestion(sentId, input);
  bot.log(`? asked the group to confirm: ${lines.join("; ")}`);
  return true;
}

/** "yes", "y", "👍" / "no", "skip", "👎" ... */
export function parseAnswer(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:y|yes|yeah|yep|yup|yes please|sure|ok|okay|confirm|go ahead|do it|👍|✅|👌)$/u.test(t)) return "yes";
  if (/^(?:n|no|nope|nah|no thanks|skip|cancel|don'?t|👎|❌)$/u.test(t)) return "no";
  return null;
}

/** Applies preferences: creates the shop if needed, saves the rule, and moves the item if it's on the list. */
async function applyPreferences(bot: Bot, preferences: Preference[]): Promise<{ count: number; saved: string[]; newPlaces: string[] }> {
  let applied = 0;
  const saved: string[] = [], newPlaces: string[] = [];
  for (const p of preferences) {
    const shops = await bot.store.shops();
    let shop: { id: string | null; name: string } = resolvePreferenceShop(p.shop, shops);
    if (!shop.id) {
      const priority = Math.max(100, ...shops.map((s) => s.priority)) + 10;
      const created = await bot.store.addShop({ name: shop.name, example_items: [p.item], priority });
      if (!created) { bot.log(`✗ shop ${shop.name}`); continue; }
      shop = created;
      bot.log(`+ shop ${created.name}`);
      newPlaces.push(created.name);
    }
    await bot.store.upsertRules([{ item_name: p.item, shop_id: shop.id!, origin: "answer" }]);
    await bot.store.moveNeededByKey(normalise(p.item), shop.id!);
    bot.log(`✓ rule: ${p.item} → ${shop.name}`);
    saved.push(`${p.item} → ${shop.name}`);
    applied++;
  }
  return { count: applied, saved, newPlaces };
}

/**
 * Handles a yes/no. Returns false if there was no open question it could belong to,
 * so the message is treated as ordinary chat.
 */
async function handleAnswer(bot: Bot, answer: "yes" | "no", answeredBy: string, quotedId: string | null): Promise<boolean> {
  const open = await bot.store.openQuestions(quotedId, quotedId ? QUESTION_TTL_MS : BARE_ANSWER_WINDOW_MS);
  if (!open.length) return false;
  if (open.length > 1) {
    await bot.chat.send("I've asked a few questions; please reply *yes* or *no* directly to the one you mean.");
    return true;
  }
  const task = open[0];
  const input = task.input;
  await bot.pause(600, 1500);
  if (answer === "no") {
    await bot.store.closeTask(task.id, { answer: "no", by: answeredBy });
    await bot.chat.send("👍 Skipped.");
    bot.log(`✗ ${answeredBy} said no; nothing changed`);
    return true;
  }
  const syn = input.synonyms?.length ? await saveSynonymPairs(bot, input.synonyms) : null; // first, so matching uses them
  const prefs = await applyPreferences(bot, input.preferences);          // first, so added items land in the new place
  prefs.newPlaces.push(...(await createNamedShops(bot, input.actions)));  // "add Costco as a place and put … there"
  const result = await applyActions(bot, input.actions, input.sender, task.id);
  await bot.store.closeTask(task.id, { answer: "yes", by: answeredBy, changes: result.changes, rules: prefs.count });
  const addedItems = new Set(input.actions.filter((a) => a.kind === "add").map((a) => normalise(a.name)));
  const ruleOnly = prefs.saved.filter((line) => !addedItems.has(normalise(line.split(" → ")[0])));
  const text = [
    result.summary.replace(/^✅ /, "").replace(/\.$/, ""),
    prefs.newPlaces.length ? `New place: ${andList(prefs.newPlaces)}` : "",
    ruleOnly.length ? `Saved: ${andList(ruleOnly)}` : "",
    syn?.saved.length ? `Saved: ${andList(syn.saved)}` : "",
    syn?.already.length ? `${andList(syn.already)} ${syn.already.length === 1 ? "was" : "were"} already saved` : "",
    syn?.moved ? `Moved ${items(syn.moved)} out of review` : "",
  ].filter(Boolean).join(". ");
  await bot.chat.send(`✅ ${text || "Done"}.`);
  bot.log(`✓ ${answeredBy} confirmed: ${result.changes} list change(s), ${prefs.count} rule(s)`);
  bot.afterChange();
  return true;
}

/** Reads messages parked while the AI was off, once it's back. */
export async function processQueuedMessages(bot: Bot): Promise<void> {
  if (!bot.state.aiReady) return;
  const tasks = await bot.store.parkedMessages(5);
  for (const task of tasks) {
    const input = task.input;
    try {
      await bot.store.setTaskRunning(task.id);
      bot.log(`[parked, ${input.sender}] ${input.text.replace(/\n/g, " / ")}`);
      const t = await bot.ai.toEnglish(input.text, [...(await loadSynonyms(bot)).keys()]);
      const unsure = t.language !== "English" && t.confidence < 0.7;
      if (t.language !== "English") bot.log(`AI translated from ${t.language} (${Math.round(t.confidence * 100)}% sure): ${t.english}`);
      const reading = await readMessage(bot, t.english);
      if (reading.parked) throw new Error("the AI stopped again");
      await bot.store.closeTask(task.id, reading);
      if (reading.fromAi || unsure) {
        await askToConfirm(bot, { sender: input.sender, ref: input.key }, reading, unsure ? t.english : undefined);
      } else {
        const result = await applyActions(bot, reading.actions, input.sender, task.id);
        if (result.summary) {
          await reply(bot);
          await bot.chat.send(`${result.summary.replace(/\.$/, "")} (from ${input.sender}'s earlier message).`);
        }
      }
    } catch (err) {
      await bot.store.setTaskQueued(task.id);
      bot.state.aiReady = false;
      bot.log(`AI unavailable for queued message: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Changing the list

type ApplyResult = { changes: number; summary: string };

/** Applies a message's actions to the list, with a short summary for the group. */
export async function applyActions(bot: Bot, actions: ParsedAction[], sender: string, messageId: string): Promise<ApplyResult> {
  if (actions.length === 0) return { changes: 0, summary: "" };
  const [shops, rules, needed, members, synonyms] = await Promise.all([
    bot.store.shops(), bot.store.rules(), bot.store.neededItems(), bot.store.members(), loadSynonyms(bot),
  ]);
  let recent: Awaited<ReturnType<typeof bot.store.recentlyBought>> | null = null; // loaded only if needed
  const requester = members.find((n) => normalise(n) === normalise(sender)) ?? sender;
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const added: string[] = [], updated: string[] = [], bought: string[] = [], removed: string[] = [], missing: string[] = [];
  const alreadyDone: string[] = [];
  let changes = 0;
  for (const action of actions) {
    const key = normalise(action.name);
    const existing = needed.find((it) => sameItem(it.item_key, key, synonyms)); // "paal" merges into "milk"

    if (action.kind === "add") {
      const named = namedShop(action.shop, shops);   // "from Costco": this trip's shop
      if (existing && named && existing.shop_id !== named.id) {
        // Already on the list under another shop: move it there for this trip.
        await bot.store.updateItem(existing.id, { shop_id: named.id });
        bot.log(`→ ${action.name} moved to ${named.name} (named in the message)`);
        existing.shop_id = named.id;
        updated.push(`${action.name} (moved to ${named.name})`);
        changes++;
        continue;
      }
      if (existing) {
        const requested_by = existing.requested_by.includes(requester) ? existing.requested_by : [...existing.requested_by, requester];
        const isExtra = !!action.quantity && (action.quantity === "extra" || action.quantity.startsWith("+"));
        const quantity = isExtra && existing.quantity
          ? `${existing.quantity} + ${action.quantity!.replace(/^\+/, "")}`
          : action.quantity ?? existing.quantity;
        await bot.store.updateItem(existing.id, { requested_by, quantity });
        existing.requested_by = requested_by;
        existing.quantity = quantity;
        bot.log(`= ${action.name} (already on the list; added ${requester})`);
        updated.push(quantity ? `${action.name} (${quantity})` : action.name);
      } else {
        const shop_id = named?.id ?? suggestShop(key, rules, shops, synonyms);
        const item = await bot.store.addItem({ name: action.name, quantity: action.quantity, shop_id, requested_by: [requester], source_message_id: messageId });
        if (!item) { bot.log(`✗ ${action.name}`); continue; }
        needed.push(item);
        bot.log(`+ ${action.name}${action.quantity ? ` (${action.quantity})` : ""} → ${named ? `${named.name} (named in the message)` : shop_id ? `${shopName.get(shop_id)} (matched by a rule)` : "Needs review"}`);
        added.push(`${action.name} (${shop_id ? shopName.get(shop_id) : "needs review"})`);
      }
      changes++;
    } else if (existing) {
      const status = action.kind === "bought" ? "bought" : "removed";
      await bot.store.setStatus([existing.id], status, { by: requester });
      needed.splice(needed.indexOf(existing), 1);
      bot.log(`${status === "bought" ? "✓" : "−"} ${action.name} (${status})`);
      (status === "bought" ? bought : removed).push(action.name);
      changes++;
    } else {
      // Not on the list. Was it ticked off recently? Then say who and when, so nobody buys it twice.
      recent ??= await bot.store.recentlyBought(new Date(bot.now().getTime() - RECENT_MS).toISOString());
      const done = recent.find((r) => sameItem(r.item_key, key, synonyms));
      if (done) {
        const who = !done.bought_by ? "" : normalise(done.bought_by) === normalise(requester) ? "You" : done.bought_by;
        const when = whenSaid(done.bought_at, bot.now());
        alreadyDone.push(who ? `${who} already ticked off ${done.name} ${when}` : `${done.name} was already ticked off ${when}`);
        bot.log(`? ${action.name}: already ticked off ${when}${done.bought_by ? ` by ${done.bought_by}` : ""}`);
      } else {
        bot.log(`? ${action.name}: not on the list, nothing to ${action.kind === "bought" ? "tick" : "remove"}`);
        missing.push(action.name);
      }
    }
  }
  const parts = [
    added.length ? `Added ${andList(added)}` : "",
    updated.length ? `Updated ${andList(updated)}` : "",
    bought.length ? `Ticked off ${andList(bought)}` : "",
    removed.length ? `Removed ${andList(removed)}` : "",
    ...alreadyDone,
    missing.length ? `${andList(missing)} ${missing.length === 1 ? "wasn't" : "weren't"} on the list` : "",
  ].filter(Boolean);
  return { changes, summary: parts.length ? `${changes > 0 ? "✅ " : ""}${parts.join(". ")}.` : "" };
}

/** How far back "already ticked off" looks. */
const RECENT_MS = 24 * 3600 * 1000;

/** "at 14:20" today, "yesterday at 18:05" (UK time). */
function whenSaid(iso: string, now: Date): string {
  const opts = { timeZone: "Europe/London" } as const;
  const day = (d: Date) => d.toLocaleDateString("en-GB", opts);
  const t = new Date(iso);
  const time = t.toLocaleTimeString("en-GB", { ...opts, hour: "2-digit", minute: "2-digit" });
  if (day(t) === day(now)) return `at ${time}`;
  if (day(t) === day(new Date(now.getTime() - 24 * 3600 * 1000))) return `yesterday at ${time}`;
  return `on ${t.toLocaleDateString("en-GB", { ...opts, weekday: "long" })} at ${time}`;
}

/** The current list as a WhatsApp message, shop by shop, plus the ids of the items on it. */
export async function buildListMessage(bot: Bot): Promise<{ text: string; itemIds: string[] }> {
  const [shops, needed] = await Promise.all([bot.store.shops(), bot.store.neededItems()]);
  return { text: formatListMessage(shops, needed, bot.now()), itemIds: needed.map((i) => i.id) };
}

/**
 * "Done" handling.
 *   Done (reply to a list)        -> tick off everything on that list
 *   done costco                   -> tick off every Costco item now on the list
 *   done costco (reply to a list) -> tick off the Costco items that were on that list
 * A "done" that matches nothing is left alone, so chat like "done for today" is harmless.
 */
async function handleDone(bot: Bot, shopSaid: string | null, quotedId: string | null, by: string): Promise<void> {
  const quotedList = quotedId ? await bot.store.listItemIds(quotedId) : undefined;

  if (!shopSaid) {
    if (!quotedList) { bot.log("(Done, but not as a reply to a list; left alone)"); return; }
    const cleared = quotedList.length ? (await bot.store.setStatus(quotedList, "bought", { by })).length : 0;
    const remaining = (await bot.store.neededItems()).length;
    await reply(bot);
    const since = remaining > 0 ? ` ${items(remaining)} added since is still on; send "list" to see.` : "";
    await bot.chat.send(`✅ Ticked off ${items(cleared)}.${since}`);
    bot.log(`✓ Done: ticked off ${cleared} item(s); ${remaining} still on the list`);
    return;
  }

  const shops = await bot.store.shops();
  const match = matchShopName(shopSaid, shops);
  if (match.kind === "none") {
    bot.log(`(done "${shopSaid}": no shop by that name; left alone)`);
    if (quotedList) {
      await reply(bot);
      await bot.chat.send(`I don't know a shop called "${shopSaid}". Your shops: ${shops.map((s) => s.name).join(", ")}.`);
    }
    return;
  }
  if (match.kind === "several") {
    await reply(bot);
    await bot.chat.send(`Which one: ${match.shops.map((s) => s.name).join(" or ")}? Reply e.g. "done ${match.shops[0].name}".`);
    return;
  }
  const n = (await bot.store.setStatus(quotedList ?? "all", "bought", { shopId: match.shop.id, by })).length;
  await reply(bot);
  if (n === 0) {
    await bot.chat.send(`Nothing left on the ${match.shop.name} list.`);
    bot.log(`(done ${match.shop.name}: nothing to tick off)`);
    return;
  }
  await bot.chat.send(`✅ Ticked off ${items(n)} at ${match.shop.name}.`);
  bot.log(`✓ Done at ${match.shop.name}: ticked off ${n} item(s)`);
}

/**
 * "paal means milk" (or several pairs) -> saves the pairs, then re-checks Needs review:
 * items a synonym can now place are moved to their shop. One short reply for the whole message.
 */
async function handleSynonyms(bot: Bot, pairs: SynonymPairInput[]): Promise<void> {
  const { saved, already, moved } = await saveSynonymPairs(bot, pairs);
  const text = [
    saved.length ? `✅ Saved: ${andList(saved)}.` : "",
    already.length ? `${andList(already)} ${already.length === 1 ? "was" : "were"} already saved.` : "",
    moved ? `Moved ${items(moved)} out of review.` : "",
  ].filter(Boolean).join(" ");
  await reply(bot);
  if (text) await bot.chat.send(text);
  bot.log(`✓ synonyms: ${text}`);
}

/** Saves synonym pairs and moves any Needs review items they can now place. */
async function saveSynonymPairs(bot: Bot, pairs: SynonymPairInput[]): Promise<{ saved: string[]; already: string[]; moved: number }> {
  const saved: string[] = [], already: string[] = [];
  for (const { a, b } of pairs) {
    const groups = await loadSynonyms(bot);
    if (sameItem(normalise(a), normalise(b), groups)) { already.push(`${a} = ${b}`); continue; }
    if (!(await bot.store.addSynonym(a, b))) { bot.log(`✗ synonym ${a} = ${b}`); continue; }
    saved.push(`${a} = ${b}`);
  }
  let moved = 0;
  if (saved.length) {
    const groups = await loadSynonyms(bot);
    const [shops, rules, needed] = await Promise.all([bot.store.shops(), bot.store.rules(), bot.store.neededItems()]);
    for (const item of needed.filter((i) => !i.shop_id)) {
      const shop_id = suggestShop(item.item_key, rules, shops, groups);
      if (!shop_id) continue;
      await bot.store.updateItem(item.id, { shop_id });
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
async function handleReplace(bot: Bot, m: IncomingMessage, from: string, to: string): Promise<void> {
  const needed = await bot.store.neededItems();
  const plan = planReplace(needed as ReplaceItem[], from, to);
  await reply(bot);
  if (plan.renamed.length === 0) {
    await bot.chat.send(`No ${from} on the list.`, m);
    bot.log(`(replace: no ${from} on the list)`);
    return;
  }
  for (const u of plan.updates) await bot.store.updateItem(u.id, { name: u.name, quantity: u.quantity, requested_by: u.requested_by });
  if (plan.deletes.length) await bot.store.deleteItems(plan.deletes);

  // Renamed items still in Needs review: try the new name against rules and synonyms.
  const [shops, rules, synonyms, after] = await Promise.all([bot.store.shops(), bot.store.rules(), loadSynonyms(bot), bot.store.neededItems()]);
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const survivors = new Set(plan.updates.map((u) => u.id));
  let placed = 0;
  const stillReview: string[] = [];
  for (const r of after.filter((i) => survivors.has(i.id) && !i.shop_id)) {
    const shop_id = suggestShop(normalise(to), rules, shops, synonyms);
    if (shop_id) { await bot.store.updateItem(r.id, { shop_id }); placed++; }
    else stillReview.push(r.id);
  }
  if (stillReview.length) await bot.store.clearProposals(stillReview); // AI looks again

  const where = plan.mergedShops.map((g) => (g.shop_id ? shopName.get(g.shop_id) ?? "a shop" : "Needs review"));
  const text = [
    `✅ Replaced ${from} with ${to} (${items(plan.renamed.length)}).`,
    where.length ? `Merged duplicates at ${andList(where)}.` : "",
    placed ? `Moved ${items(placed)} out of review.` : "",
  ].filter(Boolean).join(" ");
  await bot.chat.send(text, m);
  bot.log(`✓ ${text}`);
  bot.afterChange();
}

/** "add shop Lidl" -> creates the shop (and starting rules for any example items). */
async function handleAddShop(bot: Bot, name: string, exampleItems: string[]): Promise<void> {
  const shops = await bot.store.shops();
  const existing = shops.find((s) => normalise(s.name) === normalise(name));
  if (existing) {
    await reply(bot);
    await bot.chat.send(`${existing.name} is already one of your shops.`);
    bot.log(`(add shop ${name}: already exists)`);
    return;
  }
  // New shops go to the end of the priority order; change it on the group settings page.
  const priority = Math.max(100, ...shops.map((s) => s.priority)) + 10;
  const shop = await bot.store.addShop({ name, example_items: exampleItems, priority });
  if (!shop) { bot.log(`✗ add shop ${name}`); return; }
  if (exampleItems.length) {
    await bot.store.upsertRules(exampleItems.map((item_name) => ({ item_name, shop_id: shop.id, origin: "setup" as const })));
  }
  // Let the AI take another look at review items it couldn't place before.
  await bot.store.clearProposals("unproposed");
  bot.afterChange();
  await reply(bot);
  const extra = exampleItems.length ? ` with ${exampleItems.join(", ")}` : "";
  await bot.chat.send(`✅ Added shop *${shop.name}*${extra}.`);
  bot.log(`+ shop ${shop.name}${extra}`);
}

// ---------------------------------------------------------------------------
// AI shop suggestions for Needs review (shown on the web page)

/** Proposes a shop for every item in "Needs review" that the AI hasn't looked at yet. */
export async function proposeForReviewItems(bot: Bot): Promise<void> {
  if (!bot.state.aiReady || bot.state.aiBusy) return;
  bot.state.aiBusy = true;
  try {
    const pending = await bot.store.itemsAwaitingProposal(10);
    if (!pending.length) return;
    const [shopRows, rules, pairs] = await Promise.all([bot.store.shops(), bot.store.rules(), bot.store.synonymPairs()]);
    const shops: AiShop[] = shopRows;
    if (shops.length === 0) return;
    const sameThings = groupList(buildSynonymGroups(pairs));
    const shopName = new Map(shops.map((s) => [s.id, s.name]));
    const past = rules.slice(0, 60).filter((r) => shopName.has(r.shop_id)).map((r) => ({ item: r.item_name, shop: shopName.get(r.shop_id)! }));
    for (const item of pending) {
      const p = await bot.ai.proposeShop(item.name, shops, past, sameThings);
      await bot.store.saveProposal(item.id, {
        shopId: p.shopId,
        confidence: p.confidence,
        reason: p.isItem ? p.reason : `May not be a shopping item. ${p.reason}`.trim(),
      });
      bot.log(`AI suggests: ${item.name} → ${p.isItem ? (p.shopId ? shopName.get(p.shopId) : "no idea") : "not an item?"} (${Math.round(p.confidence * 100)}%) ${p.reason}`);
    }
  } catch (err) {
    bot.log(`AI worker error: ${err instanceof Error ? err.message : err}`);
    bot.state.aiReady = false;
  } finally {
    bot.state.aiBusy = false;
  }
}

export type { BotItem };
export { maybeStartOnboarding } from "./onboarding";
