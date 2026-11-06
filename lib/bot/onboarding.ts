/**
 * The setup chat: a new group with no shops is asked a few questions in WhatsApp,
 * so it works well from the first message without anyone using the web page.
 *
 *   1. "Which shops do you usually buy from?"            -> creates the shops
 *   2. For each shop: "What do you usually buy at X?"    -> example items (rules)
 *      with the AI's guess offered as a starting point ("Reply yes to use that")
 *   Then a tip, not a question: family words ("pal means milk") can be taught any time.
 *
 * "skip" skips a question, "stop setup" ends it; "list", "help" and "summary" still
 * work meanwhile. If nobody answers for a day, the setup quietly ends.
 */
import { parseMessage, parseMessageDetailed } from "../parse";
import { normalise } from "../matching";
import { tidyShopName } from "../ai";
import { isListRequest } from "../format";
import { isHelpRequest, isSummaryRequest } from "../info";
import { matchShopName, parseSynonyms, parseTanglishMeans } from "../commands";
import type { Bot, BotShop, IncomingMessage, Onboarding, SynonymPairInput } from "./ports";

const STALE_MS = 24 * 3600 * 1000;
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const bold = (x: string) => `*${x}*`;
const SKIP = /^(?:skip|no|nope|nah|none|nothing|not really|pass|n|-)[\s.!]*$/i;
const STOP = /^(?:stop|end|cancel|quit|exit)\s+(?:the\s+)?setup[\s.!]*$|^setup\s+later[\s.!]*$/i;
const YES = /^(?:y|yes|yeah|yep|yup|sure|ok|okay|sounds good|perfect|that'?s right|correct|👍|✅|👌)[\s.!]*$/iu;

/** Starts the setup chat if this group has no shops and has never been asked. */
export async function maybeStartOnboarding(bot: Bot): Promise<void> {
  if (await bot.store.getOnboarding()) return;
  if ((await bot.store.shops()).length > 0) return;
  await bot.store.setOnboarding({ step: "shops", shopIds: [], index: 0, guess: null, askedAt: bot.now().toISOString() });
  await bot.pause(800, 1500);
  await bot.chat.send(
    "👋 Let's set up your shopping list. It takes a minute.\n\n" +
    "Which shops do you usually buy from? For example: *Tesco, Lidl, Indian grocer*.\n\n" +
    "_Reply *skip* to skip a question, or *stop setup* to finish later._",
  );
  bot.log("setup chat started: asked for the family's shops");
}

/**
 * If a setup chat is open, treats this message as its answer and returns true.
 * Returns false when there's no open setup, or the message is a list/help/summary request.
 */
export async function handleOnboarding(bot: Bot, m: IncomingMessage): Promise<boolean> {
  const ob = await bot.store.getOnboarding();
  if (!ob || ob.step === "done") return false;
  if (bot.now().getTime() - Date.parse(ob.askedAt) > STALE_MS) {
    await bot.store.setOnboarding({ ...ob, step: "done" });
    bot.log("setup chat: no answer for a day, so it ended quietly");
    return false;
  }
  if (isListRequest(m.text) || isHelpRequest(m.text) || isSummaryRequest(m.text)) return false;

  const text = m.text.trim();
  if (STOP.test(text)) {
    await bot.store.setOnboarding({ ...ob, step: "done" });
    await bot.pause(600, 1200);
    await bot.chat.send("👍 Setup stopped. You can add shops any time with *add shop Lidl*, or on the web page.", m);
    bot.log("setup chat: stopped by the family");
    return true;
  }
  bot.log(`setup chat: answer to the ${ob.step} question`);
  if (ob.step === "shops") await answerShops(bot, ob, m);
  else if (ob.step === "items") await answerItems(bot, ob, m);
  else await answerWords(bot, ob, m);
  return true;
}

// ---------------------------------------------------------------------------

/** Names listed in an answer: rules for a plain list, the AI for a sentence. */
async function readNames(bot: Bot, kind: "shops" | "items", text: string): Promise<string[]> {
  const detailed = parseMessageDetailed(text);
  if (!detailed.needsAi) {
    const names = detailed.actions.map((a) => a.name);
    bot.log(`rules read the ${kind}: ${names.join(", ") || "none"}`);
    return names;
  }
  if (bot.state.aiReady) {
    try {
      const names = await bot.ai.readList(kind, text);
      bot.log(`AI read the ${kind}: ${names.join(", ") || "none"}`);
      return names;
    } catch (err) {
      bot.state.aiReady = false;
      bot.log(`AI unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
  const names = parseMessage(text.replace(/\b(?:we|usually|mostly|normally|go to|shop at|buy from|sometimes|and also|also)\b/gi, ",")).map((a) => a.name);
  bot.log(`rules read the ${kind} (AI off): ${names.join(", ") || "none"}`);
  return names;
}

async function answerShops(bot: Bot, ob: Onboarding, m: IncomingMessage): Promise<void> {
  if (SKIP.test(m.text.trim())) return finishShopsSkipped(bot, ob, m);
  const said = [...new Set((await readNames(bot, "shops", m.text)).map(tidyShopName).filter(Boolean))];
  if (said.length === 0) {
    await bot.pause(600, 1200);
    await bot.chat.send("I didn't catch any shop names. Which shops do you usually buy from? For example: *Tesco, Lidl, Indian grocer*.", m);
    await bot.store.setOnboarding({ ...ob, askedAt: bot.now().toISOString() });
    return;
  }
  const existing = await bot.store.shops();
  const shops: BotShop[] = [];
  const already: string[] = [];
  let priority = Math.max(0, ...existing.map((s) => s.priority));
  for (const name of said.slice(0, 8)) {
    const match = matchShopName(name, existing);
    if (match.kind === "one" && normalise(match.shop.name) === normalise(name)) { shops.push(match.shop); already.push(match.shop.name); continue; }
    priority += 10;
    const shop = await bot.store.addShop({ name, example_items: [], priority });
    if (shop) { shops.push(shop); bot.log(`+ shop ${shop.name}`); }
  }
  const next: Onboarding = { step: "items", shopIds: shops.map((s) => s.id), index: 0, guess: null, askedAt: bot.now().toISOString() };
  const ack = `✅ Added ${andList(shops.filter((s) => !already.includes(s.name)).map((s) => bold(s.name)))}.`.replace("✅ Added .", "✅ Got it.");
  await askAboutShop(bot, next, ack, m);
}

async function finishShopsSkipped(bot: Bot, ob: Onboarding, m: IncomingMessage): Promise<void> {
  await finish(bot, ob, "👍 Skipped. You can add shops any time with *add shop Lidl*.", m);
}

/** Asks what the family buys at the current shop, offering the AI's guess. */
async function askAboutShop(bot: Bot, ob: Onboarding, before: string, quote: IncomingMessage | null): Promise<void> {
  const shops = await bot.store.shops();
  const shop = shops.find((s) => s.id === ob.shopIds[ob.index]);
  if (!shop) return finish(bot, ob, before, quote);
  let guess: Onboarding["guess"] = null;
  if (bot.state.aiReady) {
    try {
      const g = await bot.ai.guessShopItems(shop.name);
      if (g.examples.length >= 2 && g.confidence >= 0.4) guess = { examples: g.examples.slice(0, 6), categories: g.categories };
      bot.log(`AI guessed for ${shop.name}: ${g.examples.join(", ") || "nothing"} (${Math.round(g.confidence * 100)}% sure)`);
    } catch (err) {
      bot.state.aiReady = false;
      bot.log(`AI unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
  const progress = ob.shopIds.length > 1 ? ` (${ob.index + 1} of ${ob.shopIds.length})` : "";
  const question = guess
    ? `What do you usually buy at ${bold(shop.name)}${progress}? My guess: ${andList(guess.examples)}. Reply *yes* to use that, or tell me your own.`
    : `What do you usually buy at ${bold(shop.name)}${progress}? A few things is enough, for example *${shop.name === "Tesco" ? "milk, bread, eggs" : "milk, bread"}*.`;
  await bot.store.setOnboarding({ ...ob, guess, askedAt: bot.now().toISOString() });
  await bot.pause(600, 1200);
  await bot.chat.send(`${before ? `${before}\n\n` : ""}${question}`, quote);
}

async function answerItems(bot: Bot, ob: Onboarding, m: IncomingMessage): Promise<void> {
  const shops = await bot.store.shops();
  const shop = shops.find((s) => s.id === ob.shopIds[ob.index]);
  const text = m.text.trim();
  let ack: string;
  if (!shop) {
    ack = "";
  } else if (SKIP.test(text)) {
    ack = `👍 Skipped ${shop.name}.`;
  } else {
    const useGuess = YES.test(text) && !!ob.guess;
    const items = useGuess ? ob.guess!.examples : await readNames(bot, "items", text);
    if (items.length === 0) {
      await bot.pause(600, 1200);
      await bot.chat.send(`I didn't catch any items. What do you usually buy at ${bold(shop.name)}? Or reply *skip*.`, m);
      await bot.store.setOnboarding({ ...ob, askedAt: bot.now().toISOString() });
      return;
    }
    const examples = [...new Set([...shop.example_items, ...items.map((i) => i.trim().toLowerCase())])];
    const categories = useGuess ? [...new Set([...shop.categories, ...ob.guess!.categories])] : shop.categories;
    await bot.store.updateShop(shop.id, { example_items: examples, categories });
    await bot.store.upsertRules(items.map((item_name) => ({ item_name, shop_id: shop.id, origin: "setup" as const })));
    bot.log(`✓ ${shop.name}: ${items.join(", ")}${useGuess ? " (the AI's guess, confirmed)" : ""}`);
    ack = `✅ ${bold(shop.name)}: ${andList(items)}.`;
  }
  const next: Onboarding = { ...ob, index: ob.index + 1, guess: null };
  if (next.index < next.shopIds.length) return askAboutShop(bot, next, ack, m);
  return finish(bot, next, ack, m);
}

/** Ends the setup chat: what's set up, how to use it, and a tip about family words. */
async function finish(bot: Bot, ob: Onboarding, before: string, quote: IncomingMessage | null): Promise<void> {
  await bot.store.setOnboarding({ ...ob, step: "done", guess: null, askedAt: bot.now().toISOString() });
  const shops = (await bot.store.shops()).map((s) => s.name);
  await bot.pause(600, 1200);
  await bot.chat.send(
    `${before ? `${before}\n\n` : ""}🎉 All set!${shops.length ? ` Your shops: ${andList(shops)}.` : ""}\n` +
    "Just type what you need, like *milk, eggs*, and I'll sort it by shop. Send *help* any time.\n\n" +
    "💡 If your family uses special names for items, tell me about them, like *pal means milk*. I'll remember them next time.",
    quote,
  );
  bot.log("setup chat finished");
}

/** "paal = milk, thayir = curd", "paal means milk", "paal for milk", "riz na rice" */
function readWordPairs(text: string): SynonymPairInput[] {
  const all = parseSynonyms(text);
  if (all) return all;
  const pairs: SynonymPairInput[] = [];
  for (const part of text.split(/\n|;|,|\s+and\s+/i).map((p) => p.trim()).filter(Boolean)) {
    const tanglish = parseTanglishMeans(part);
    if (tanglish) { pairs.push(tanglish); continue; }
    const m = part.match(/^(.{1,30}?)\s+(?:is|for|->|→|-|:)\s+(.{1,30}?)[\s.!]*$/i);
    if (m && m[1].split(/\s+/).length <= 3 && m[2].split(/\s+/).length <= 3) pairs.push({ a: m[1].trim(), b: m[2].trim() });
  }
  return pairs;
}

async function answerWords(bot: Bot, ob: Onboarding, m: IncomingMessage): Promise<void> {
  const text = m.text.trim();
  let ack = "";
  if (!SKIP.test(text)) {
    const pairs = readWordPairs(text);
    const saved: string[] = [];
    for (const p of pairs) if (await bot.store.addSynonym(p.a, p.b)) saved.push(`${p.a} = ${p.b}`);
    bot.log(saved.length ? `✓ family words: ${saved.join(", ")}` : "no family words found in the answer");
    ack = saved.length ? `✅ Saved ${andList(saved.map(bold))}.` : "I didn't catch any words; you can add them any time with *paal means milk*.";
  }
  await finish(bot, ob, ack, m);
}
