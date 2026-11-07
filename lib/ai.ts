/**
 * Local AI (Qwen via Ollama on this Mac) that proposes a shop for an item.
 * Nothing leaves the Mac and there is no API bill.
 *
 * It sees the family's shops (what each sells, example items, notes) and the
 * family's past decisions (saved rules), so its suggestions improve as the
 * family confirms or corrects them on the web page.
 */

export type AiShop = { id: string; name: string; categories: string[]; example_items: string[]; notes: string | null };
export type PastChoice = { item: string; shop: string };
export type Proposal = { isItem: boolean; shopId: string | null; confidence: number; reason: string };

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";

/**
 * How a prompt reaches a model and comes back as JSON. The prompts below are the
 * same whichever model answers: Ollama on the Mac (the family bot) or a hosted
 * model such as Qwen on Groq (the website's demo, see lib/ai-groq.ts).
 */
export type JsonLlm = (req: { system: string; user: string; schema: object; temperature: number }) => Promise<unknown>;

/** Ollama on this Mac: the reply is constrained to the JSON schema. */
export const ollamaJson: JsonLlm = async ({ system, user, schema, temperature }) => {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: schema,               // Ollama constrains the reply to this JSON shape
      keep_alive: "10m",            // unload the model after 10 idle minutes to free memory
      options: { temperature },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return JSON.parse(data.message?.content ?? "{}");
};

/** Is Ollama running, with the chosen model installed? */
export async function checkOllama(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const body = (await res.json()) as { models?: { name: string }[] };
    const names = (body.models ?? []).map((m) => m.name);
    const found = names.some((n) => n === OLLAMA_MODEL || n === `${OLLAMA_MODEL}:latest`);
    if (!found) {
      return {
        ok: false,
        message: `Model "${OLLAMA_MODEL}" isn't installed in Ollama. Installed: ${names.join(", ") || "none"}. ` +
          `Set OLLAMA_MODEL in .env.local to one of these.`,
      };
    }
    return { ok: true, message: `Local AI ready (${OLLAMA_MODEL})` };
  } catch {
    return { ok: false, message: `Ollama isn't reachable at ${OLLAMA_URL}. Open the Ollama app, then restart the listener.` };
  }
}

const SYSTEM_PROMPT = [
  "You help a UK family sort their shopping list by shop.",
  "Pick the single best shop for the item from the family's own shops, using what each shop sells, its example items,",
  "and the family's past choices (these show their habits and matter most).",
  "same_things lists words the family uses for the same item (\"paal\" = \"milk\"): treat them as one item.",
  'If the text is not something you buy in a shop (for example chat such as "running late"), set is_item to false and shop to "unknown".',
  'If no shop fits, use "unknown".',
  "confidence is 0 to 1. reason is at most 12 words, plain English.",
].join(" ");

export async function proposeShop(item: string, shops: AiShop[], past: PastChoice[], sameThings: string[][] = [], llm: JsonLlm = ollamaJson): Promise<Proposal> {
  const names = shops.map((s) => s.name);
  const schema = {
    type: "object",
    properties: {
      is_item: { type: "boolean" },
      shop: { type: "string", enum: [...names, "unknown"] },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
    required: ["is_item", "shop", "confidence", "reason"],
  };
  const context = {
    shops: shops.map((s) => ({
      name: s.name,
      sells: s.categories,
      examples: s.example_items,
      ...(s.notes ? { notes: s.notes } : {}),
    })),
    past_choices: past.slice(0, 60),
    // words this family uses for the same thing, e.g. ["paal", "milk"]
    ...(sameThings.length ? { same_things: sameThings } : {}),
    item,
  };

  const out = (await llm({ system: SYSTEM_PROMPT, user: JSON.stringify(context), schema, temperature: 0 })) as { is_item?: boolean; shop?: string; confidence?: number; reason?: string };
  const isItem = out.is_item !== false;
  const shop = shops.find((s) => s.name.toLowerCase() === String(out.shop ?? "").toLowerCase());
  return {
    isItem,
    shopId: isItem ? shop?.id ?? null : null,
    confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
    reason: String(out.reason ?? "").trim().slice(0, 140),
  };
}

// ---------------------------------------------------------------------------
// Reading free-text messages

export type ExtractedActions = {
  /** shop: a shop named for this trip ("eggs from Costco"), else null. */
  add: { name: string; quantity: string | null; shop?: string | null }[];
  bought: string[];
  remove: string[];
  /** "eggs are better in Waitrose": where an item should be bought. Not a request to buy it. */
  preferences: { item: string; shop: string }[];
};

const EXTRACT_PROMPT = [
  "You read one message from a UK family's WhatsApp group and pull out shopping list actions.",
  "The list holds things to buy (groceries, toiletries, household goods, medicines, flowers, gifts, clothes)",
  "and outings the family wants to do (films, shows, restaurants, takeaways, trips, events).",
  "An outing someone suggests is an add with a short name (\"Ramayana movie\", \"Dishoom dinner\"), plus a preference",
  "linking it to the place (cinema, theatre, restaurant) when a place is named.",
  "Pure logistics are not actions: \"running late\", \"home by 7\", \"see you at dinner\".",
  "add: things someone wants bought, including things that have run out or are finished",
  "(\"rice is over\", \"out of milk\", \"tomatoes are finished\" -> add rice / milk / tomatoes).",
  "bought: things someone says they have bought or picked up.",
  "remove: things someone says are no longer needed.",
  "shop (on each add): when the message says where to buy it this time (\"buy eggs from Costco\",",
  "\"milk and yoghurt from Waitrose and almond flour from Costco\", \"pick up bread at Lidl\"), the shop as written; else null.",
  "Each shop applies to the items named with it, not to the whole message.",
  "preferences: only when someone says where an item is better, cheaper, or should always or usually be bought",
  "(\"eggs are better in Waitrose\", \"always get flowers from the florist\"), record the item and the shop as written.",
  "A shop named for one trip (\"buy eggs from Costco\") is a shop on the add, not a preference.",
  "A preference on its own is NOT a request to buy: do not also put that item in add unless they ask for it.",
  "Only record a preference when the place sells or hosts that item.",
  "Example: \"The new Ramayana movie should be seen at iMax\" -> add \"Ramayana movie\", preference {item: \"Ramayana movie\", shop: \"iMax\"}.",
  "Example: \"eggs are better in Waitrose\" -> preference {item: \"eggs\", shop: \"Waitrose\"} only (no add).",
  "Use short, plain item names as a shopper would write them (\"milk\", \"chopped tomatoes\", \"nappies size 4\").",
  "Put amounts in quantity (\"2\", \"500g\", \"2 loaves\"), else null.",
  "Ignore everything that is not a shopping action: plans, times, feelings, questions about other things.",
  "If there are no shopping actions, return empty lists. Never invent items.",
].join(" ");

export async function extractActions(message: string, llm: JsonLlm = ollamaJson): Promise<ExtractedActions> {
  const schema = {
    type: "object",
    properties: {
      add: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, quantity: { type: ["string", "null"] }, shop: { type: ["string", "null"] } },
          required: ["name", "quantity", "shop"],
        },
      },
      bought: { type: "array", items: { type: "string" } },
      remove: { type: "array", items: { type: "string" } },
      preferences: {
        type: "array",
        items: {
          type: "object",
          properties: { item: { type: "string" }, shop: { type: "string" } },
          required: ["item", "shop"],
        },
      },
    },
    required: ["add", "bought", "remove", "preferences"],
  };
  const out = (await llm({ system: EXTRACT_PROMPT, user: message, schema, temperature: 0 })) as Partial<ExtractedActions>;
  const clean = (x: unknown) => String(x ?? "").trim().slice(0, 60);
  return {
    add: (out.add ?? []).map((i) => ({ name: clean(i?.name), quantity: i?.quantity ? clean(i.quantity) : null, shop: i?.shop ? clean(i.shop) : null })).filter((i) => i.name),
    bought: (out.bought ?? []).map(clean).filter(Boolean),
    remove: (out.remove ?? []).map(clean).filter(Boolean),
    preferences: (out.preferences ?? [])
      .map((p) => ({ item: clean(p?.item), shop: tidyShopName(clean(p?.shop)) }))
      .filter((p) => p.item && p.shop),
  };
}

/**
 * Turns a shop as said in chat into a tidy shop name:
 * "the florists" -> "Florist", "the butcher's" -> "Butcher", "waitrose" -> "Waitrose".
 */
export function tidyShopName(said: string): string {
  let name = said.trim().replace(/^the\s+/i, "").replace(/['’]s$/i, "");
  // Trade names are usually said in the plural ("the florists", "the chemists"); use the singular.
  name = name.replace(/\b(\w+(?:ist|er|ant|ent))s$/i, "$1");
  const small = new Set(["and", "of", "the", "&"]);
  return name.split(/\s+/).filter(Boolean)
    // Capitalise plain lowercase words only, so brand spellings like "iMax" or "M&S" are kept.
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase()
      : w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Other languages

const TRANSLATE_PROMPT = [
  "You translate one message from a UK family's WhatsApp group into natural English.",
  "Messages are often Tanglish (Tamil written in English letters) or Hinglish (Hindi in English letters), or mix them with English.",
  "Common Tanglish: paal = milk, thayir/tayir = curd, muttai = eggs, arisi = rice, paruppu = dal, vengayam = onion,",
  "thakkali = tomato, uppu = salt, sakkarai = sugar, ennai = oil, kaai/kaikari = vegetables, pazham = fruit or banana,",
  "venum/vendum = need, vaangu/vaanganum = buy, theernduchu/mudinjiduchu = finished, irukku = there is, illa = there isn't.",
  "Common Hinglish: doodh = milk, dahi = curd, ande = eggs, chawal = rice, namak = salt, cheeni = sugar, pyaaz = onion,",
  "chahiye = need, lao/le aana = bring, khatam = finished, aur = and, na/mat = don't.",
  "When someone says one word means another (Tanglish \"X na Y\", \"X-nu Y\", \"X endral Y\", \"X means Y\"),",
  "translate it as \"X means Y\", keeping both words exactly as written.",
  "Item names should be what a UK shopper would write; keep dish and product names normally used as-is in English",
  "(paneer, ghee, dal, masala, kimchi). Keep numbers, quantities, shop and place names exactly.",
  "Keep the message's shape: commas, \"and\" and line breaks separate items, so never join, merge or drop items",
  "(\"pal,coffee\" stays two things: \"pal, coffee\").",
  "If the message is already in English, set language to \"English\" and return it unchanged.",
  "confidence is 0 to 1: how sure you are of the meaning. Use below 0.7 when the message is ambiguous",
  "(for example \"na\" could mean \"means\" or \"don't\"), or when you are unsure of a word.",
].join(" ");

/** Detects the message's language and returns it in English (unchanged if already English). */
export async function toEnglish(message: string, keepWords: string[] = [], llm: JsonLlm = ollamaJson): Promise<{ language: string; english: string; confidence: number }> {
  const keep = keepWords.length
    ? ` These are the family's own words: keep them exactly as written, never translate them: ${keepWords.join(", ")}.`
    : "";
  const out = (await llm({
    system: TRANSLATE_PROMPT + keep,
    user: message,
    schema: {
      type: "object",
      properties: { language: { type: "string" }, english: { type: "string" }, confidence: { type: "number" } },
      required: ["language", "english", "confidence"],
    },
    temperature: 0,
  })) as { language?: string; english?: string; confidence?: number };
  const language = String(out.language ?? "English").trim() || "English";
  const english = String(out.english ?? "").trim();
  const confidence = Math.max(0, Math.min(1, Number(out.confidence ?? 1) || 0));
  return /^english$/i.test(language) || !english
    ? { language: "English", english: message, confidence: 1 }
    : { language, english, confidence };
}

// ---------------------------------------------------------------------------
// Everything else: a short reply when a message isn't a shopping action

/** Current local times the model can quote; it has no clock of its own. */
function worldTimes(now: Date): Record<string, string> {
  const zones: Record<string, string> = {
    "London / UK": "Europe/London",
    "India (Chennai, Mumbai, Delhi, Bengaluru)": "Asia/Kolkata",
    "Sri Lanka (Colombo)": "Asia/Colombo",
    "Dubai / UAE": "Asia/Dubai",
    "Singapore / Malaysia": "Asia/Singapore",
    "New York / US East": "America/New_York",
    "California / US West": "America/Los_Angeles",
    "Toronto": "America/Toronto",
    "Sydney": "Australia/Sydney",
  };
  const out: Record<string, string> = {};
  for (const [label, tz] of Object.entries(zones)) {
    out[label] = now.toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  return out;
}

const CHAT_PROMPT = [
  "You are ShoppingSync, a bot in a UK family's WhatsApp group. Your main job is their shopping list.",
  "A message arrived that is not a shopping-list action. Decide two things, then reply only if both allow it.",
  "1. addressed_to: \"bot\" if it is said to you (names you, or replies to you); \"person\" if it is meant for a",
  "particular family member (uses their name or role such as Amma, Appa, Mum, Dad; or asks \"you\" something only a",
  "person could answer); \"group\" if it is open to anyone. In a family group, \"you\" usually means a family member.",
  "2. ai_can_answer: true only if you are the right source: general knowledge, the current time or date from",
  "local_times, simple facts, or how to use the shopping list. False for anything only the family knows: where",
  "people are, plans, what someone wants, where things are kept, opinions they'd want from each other, private matters.",
  "Reply only when addressed_to is \"bot\" or \"group\" AND ai_can_answer is true; otherwise reply is empty.",
  "Acknowledgements (ok, thanks, 👍, lol), greetings and chat between family members always get an empty reply.",
  "When in doubt, stay silent.",
  "When you do reply: English, at most two short sentences (under 40 words), warm and plain.",
  "You cannot browse the internet or see live data. For the time or date, use local_times (never guess).",
  "If you don't know something, say so briefly.",
].join(" ");

export type ChatContext = {
  /** Family members' names, so the model can tell when a message is for one of them. */
  members?: string[];
  /** True when the message replies to or mentions the bot. */
  toBot?: boolean;
};

/**
 * A short answer for a non-shopping message, or "" when the bot should stay quiet:
 * only when the question is for the bot or the whole group AND the AI is the right source.
 */
export async function chatReply(message: string, sender: string, ctx: ChatContext = {}, now = new Date(), llm: JsonLlm = ollamaJson): Promise<string> {
  const out = (await llm({
    system: CHAT_PROMPT,
    user: JSON.stringify({
      local_times: worldTimes(now),
      family_members: ctx.members ?? [],
      from: sender,
      replies_to_or_mentions_the_bot: !!ctx.toBot,
      message,
    }),
    schema: {
      type: "object",
      properties: {
        addressed_to: { type: "string", enum: ["bot", "group", "person"] },
        ai_can_answer: { type: "boolean" },
        reply: { type: "string" },
      },
      required: ["addressed_to", "ai_can_answer", "reply"],
    },
    temperature: 0.2,
  })) as { addressed_to?: string; ai_can_answer?: boolean; reply?: string };
  const forUs = ctx.toBot || out.addressed_to === "bot" || out.addressed_to === "group";
  if (!forUs || out.ai_can_answer !== true) return "";
  return String(out.reply ?? "").trim().slice(0, 300);
}

// ---------------------------------------------------------------------------
// Setup chat: the questions a new group is asked in WhatsApp

const LIST_PROMPT = [
  "You read one reply from a UK family's WhatsApp group to a setup question, and pull out the names it lists.",
  "kind \"shops\": the shops or places they buy from (\"Tesco\", \"the Indian shop near us\" -> \"Indian grocer\",",
  "\"the chemist\" -> \"Chemist\", \"Costco sometimes\" -> \"Costco\"). Use short names a family would write on a list.",
  "kind \"items\": the things they usually buy there, as short item names (\"milk\", \"veg\", \"curry leaves\").",
  "Keep family words and other languages exactly as written (\"paal\", \"thayir\").",
  "Never invent names. If nothing is listed, return an empty list.",
].join(" ");

/** The shops or items listed in a setup answer ("mostly Tesco and the Indian shop near us"). */
export async function readList(kind: "shops" | "items", message: string, llm: JsonLlm = ollamaJson): Promise<string[]> {
  const out = (await llm({
    system: LIST_PROMPT,
    user: JSON.stringify({ kind, reply: message }),
    schema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
    temperature: 0,
  })) as { names?: unknown[] };
  return (out.names ?? []).map((x) => String(x ?? "").trim().slice(0, 40)).filter(Boolean).slice(0, 15);
}

const SHOP_GUESS_PROMPT = [
  "A UK family has told you one of the shops they use. Guess what a family typically buys there,",
  "so the bot can offer it as a starting point. Give 4 to 8 short item names a shopper would write",
  "(\"milk\", \"bread\", \"paracetamol\") and 1 to 3 categories (\"dairy\", \"toiletries\").",
  "For an Indian, Asian or other specialist grocer, think of what that cuisine's family buys there.",
  "If the shop is unknown to you, guess from its name; confidence is 0 to 1.",
].join(" ");

/** A starting guess for a shop: "Boots" -> paracetamol, toothpaste, plasters... */
export async function guessShopItems(shop: string, llm: JsonLlm = ollamaJson): Promise<{ examples: string[]; categories: string[]; confidence: number }> {
  const out = (await llm({
    system: SHOP_GUESS_PROMPT,
    user: shop,
    schema: {
      type: "object",
      properties: {
        examples: { type: "array", items: { type: "string" } },
        categories: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
      },
      required: ["examples", "categories", "confidence"],
    },
    temperature: 0,
  })) as { examples?: unknown[]; categories?: unknown[]; confidence?: number };
  const clean = (xs: unknown[] | undefined, n: number) => (xs ?? []).map((x) => String(x ?? "").trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, n);
  return { examples: clean(out.examples, 8), categories: clean(out.categories, 3), confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)) };
}

const SHOP_ANSWER_PROMPT = [
  "You read one reply from a UK family's WhatsApp group to the setup question \"Which shops do you usually buy from?\".",
  "Split what they wrote into shops (places they buy from: supermarkets, chains, \"the Indian shop near us\" -> \"Indian grocer\",",
  "\"the chemist\" -> \"Chemist\") and items (things to buy that they mentioned instead, e.g. \"milk\", \"we need eggs\" -> \"eggs\").",
  "People often ignore the question and just post shopping: then shops is empty and items has what they want.",
  "Use short names; keep family words and other languages as written (\"paal\"). Never invent names.",
].join(" ");

/** A reply to "Which shops do you use?", split into shops and any items mentioned instead. */
export async function readShopAnswer(message: string, llm: JsonLlm = ollamaJson): Promise<{ shops: string[]; items: string[] }> {
  const out = (await llm({
    system: SHOP_ANSWER_PROMPT,
    user: message,
    schema: {
      type: "object",
      properties: { shops: { type: "array", items: { type: "string" } }, items: { type: "array", items: { type: "string" } } },
      required: ["shops", "items"],
    },
    temperature: 0,
  })) as { shops?: unknown[]; items?: unknown[] };
  const clean = (xs: unknown[] | undefined) => (xs ?? []).map((x) => String(x ?? "").trim().slice(0, 40)).filter(Boolean).slice(0, 12);
  return { shops: clean(out.shops), items: clean(out.items) };
}

// ---------------------------------------------------------------------------
// The context window: several messages read as one conversation

export type WindowInput = {
  /** Oldest first; the last one is new. from "ShoppingSync" is the bot itself. */
  messages: { from: string; text: string; replies_to: "the bot" | "someone else" | null; to_bot: boolean }[];
  members: string[];
  /** The setup question the bot is waiting on, if any ("Which shops do you usually buy from?"). */
  setup_question: string | null;
  /** What's on the list now. */
  list: { item: string; shop: string }[];
  /** Questions nobody has answered yet, possibly asked a while ago. */
  unanswered_questions: { id: string; from: string; text: string; asked: string }[];
};

export type WindowReading = {
  add: { name: string; quantity: string | null; shop?: string | null }[];
  bought: string[];
  remove: string[];
  preferences: { item: string; shop: string }[];
  /** An item someone asked about ("do we have eggs?"), for the bot to answer from the list. */
  list_question: string | null;
  /** An answer to the setup question. */
  setup_answer: { kind: "shops" | "items" | "skip" | "none"; names: string[] };
  /** A short reply to a general question meant for the bot or the group, else "". */
  reply: string;
  /** Ids of unanswered_questions the new message answers. */
  answered: string[];
  /** The new message is a shopping question (have/need/bought) nobody has answered yet: keep it. */
  track_question: boolean;
};

const WINDOW_PROMPT = [
  "You read a short stretch of a UK family's WhatsApp group, oldest message first. The LAST message is new;",
  "earlier ones are context. ShoppingSync (the bot) keeps the family's shopping list. Messages from ShoppingSync are the bot's own.",
  "Read the conversation as people would: who is answering whom. A short reply like \"No\" or \"yes\" answers the most recent",
  "question it fits, usually one a family member asked, not the bot.",
  "Work out what the NEW message, read with the context, means for the shopping list. Never repeat something an earlier",
  "message already settled.",
  "add: things the family now needs. Example: \"do we have eggs?\" then \"No\" -> add eggs. \"any milk left?\" then",
  "\"nope, we're out\" -> add milk. \"rice is over\" -> add rice. Do NOT add when the answer is yes, unclear, or the item is",
  "already in list. shop on an add only when a shop is named for this trip, else null. quantity like \"2\" or \"500g\", else null.",
  "bought: things someone says they bought or picked up. remove: things no longer needed.",
  "preferences: only when someone says where an item is better or should always be bought.",
  "list_question: when the NEW message asks whether the family has, needs or has bought an item (\"do we have eggs?\",",
  "\"is milk on the list?\", \"did anyone get bread?\"), that item, so the bot can say what the list shows. Else null.",
  "setup_answer: only when setup_question is given and the NEW message answers that question (said to the bot or the",
  "whole group, not answering a family member): kind \"shops\" or \"items\" with the names listed, or \"skip\" if they",
  "decline it. A \"No\" that answers a family member is NOT a setup answer. Otherwise kind \"none\" with no names.",
  "reply: only when the NEW message is a general question for the bot or for anyone that general knowledge answers",
  "(the time somewhere, a simple fact, how to use the list); at most two short sentences. Empty for questions about the",
  "list (list_question covers those), for anything only the family knows, for chat between family members,",
  "and for acknowledgements. When in doubt, leave everything empty.",
  "unanswered_questions are questions from earlier (maybe much earlier) that nobody has answered. A later reply can",
  "answer one even with other messages in between: \"no eggs\" or \"we're out of eggs\" answers \"do we have eggs?\".",
  "answered: the ids of unanswered_questions the NEW message answers (yes or no). If that answer means an item is needed,",
  "also put it in add.",
  "track_question: true only when the NEW message is itself a question about having, needing or buying something",
  "(\"do we have eggs?\", \"any milk left?\") that it does not answer itself; false for everything else.",
  "Holding replies are not answers and not actions: \"I need to check\", \"let me look\", \"will check\", \"not sure\",",
  "\"one sec\" -> nothing (no add, no answered).",
  "\"no eggs\" on its own means the family has no eggs (they are needed), not that eggs should not be bought, unless",
  "someone was asking what to buy.",
  "Use short, plain item names as a shopper would write them. Never invent items.",
].join(" ");

export async function readWindow(input: WindowInput, llm: JsonLlm = ollamaJson): Promise<WindowReading> {
  const names = { type: "array", items: { type: "string" } };
  const out = (await llm({
    system: WINDOW_PROMPT,
    user: JSON.stringify(input),
    schema: {
      type: "object",
      properties: {
        add: { type: "array", items: { type: "object", properties: { name: { type: "string" }, quantity: { type: ["string", "null"] }, shop: { type: ["string", "null"] } }, required: ["name", "quantity", "shop"] } },
        bought: names,
        remove: names,
        preferences: { type: "array", items: { type: "object", properties: { item: { type: "string" }, shop: { type: "string" } }, required: ["item", "shop"] } },
        list_question: { type: ["string", "null"] },
        setup_answer: { type: "object", properties: { kind: { type: "string", enum: ["shops", "items", "skip", "none"] }, names }, required: ["kind", "names"] },
        reply: { type: "string" },
        answered: names,
        track_question: { type: "boolean" },
      },
      required: ["add", "bought", "remove", "preferences", "list_question", "setup_answer", "reply", "answered", "track_question"],
    },
    temperature: 0.1,
  })) as Partial<WindowReading>;
  const strs = (x: unknown) => (Array.isArray(x) ? x : []).map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 20);
  const kind = out.setup_answer?.kind;
  return {
    add: (Array.isArray(out.add) ? out.add : []).filter((a) => a && String(a.name ?? "").trim())
      .map((a) => ({ name: String(a.name).trim(), quantity: a.quantity ? String(a.quantity) : null, shop: a.shop ? String(a.shop) : null })).slice(0, 20),
    bought: strs(out.bought),
    remove: strs(out.remove),
    preferences: (Array.isArray(out.preferences) ? out.preferences : []).filter((p) => p?.item && p?.shop)
      .map((p) => ({ item: String(p.item), shop: String(p.shop) })).slice(0, 10),
    list_question: out.list_question ? String(out.list_question).trim() || null : null,
    setup_answer: { kind: kind === "shops" || kind === "items" || kind === "skip" ? kind : "none", names: strs(out.setup_answer?.names) },
    reply: String(out.reply ?? "").trim().slice(0, 300),
    answered: strs(out.answered),
    track_question: out.track_question === true,
  };
}
