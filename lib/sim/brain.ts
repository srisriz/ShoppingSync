/**
 * Demo stand-in for the local AI (Qwen in Ollama on the owner's Mac).
 * The real bot sends sentences, other languages and open questions to the AI.
 * The demo runs in the browser with no AI, so this small, predictable reader
 * plays that part: same inputs, same output shapes as lib/ai.ts.
 */
import { tidyShopName, type ExtractedActions, type WindowInput, type WindowReading } from "../ai";
import { normalise, itemVariants, spellingKey } from "../matching";
import { splitByShop } from "../parse";

// ---------------------------------------------------------------------------
// Translation (stands in for toEnglish)

const TANGLISH: Record<string, string> = {
  paal: "milk", pal: "milk", thayir: "curd", tayir: "curd", muttai: "eggs", arisi: "rice", paruppu: "dal",
  vengayam: "onions", thakkali: "tomatoes", uppu: "salt", sakkarai: "sugar", ennai: "oil", kaikari: "vegetables",
  pazham: "bananas", kothamalli: "coriander", karuveppilai: "curry leaves", nei: "ghee", urulaikizhangu: "potatoes",
  manjal: "turmeric", milagai: "chillies", poondu: "garlic", inji: "ginger", thengai: "coconut", maavu: "flour",
  venum: "needed", vendum: "needed", veenum: "needed", vaangu: "buy", vaanganum: "need to buy",
  theernduchu: "finished", theerndhuchu: "finished", mudinjiduchu: "finished", illa: "is finished", irukku: "there is",
  um: "and", kooda: "also",
};
const HINGLISH: Record<string, string> = {
  doodh: "milk", dahi: "curd", ande: "eggs", anda: "eggs", chawal: "rice", namak: "salt", cheeni: "sugar",
  pyaaz: "onions", pyaz: "onions", aloo: "potatoes", tamatar: "tomatoes", atta: "atta", dhaniya: "coriander",
  adrak: "ginger", lehsun: "garlic", sabzi: "vegetables", tel: "oil", haldi: "turmeric", mirchi: "chillies",
  chahiye: "needed", chaiye: "needed", lao: "bring", lana: "bring", khatam: "finished", aur: "and", bhi: "also",
  "ho gaya": "", "ho gayi": "", hai: "", ka: "", ki: "", ke: "",
};
// A little Spanish and French, used only when the message clearly is one of them.
const EUROPEAN: { name: string; marker: RegExp; words: Record<string, string> }[] = [
  { name: "Spanish", marker: /\b(?:leche|pan|huevos|arroz|necesitamos|por favor|compra|mantequilla|queso|patatas)\b/i,
    words: { "por favor": "please", necesitamos: "we need", compra: "buy", leche: "milk", pan: "bread", huevos: "eggs", arroz: "rice",
      mantequilla: "butter", queso: "cheese", patatas: "potatoes", manzanas: "apples", y: "and", "más": "more", mas: "more" } },
  { name: "French", marker: /\b(?:lait|pain|oeufs|œufs|beurre|fromage|riz|s'il te pla[iî]t|il faut|acheter)\b/i,
    words: { "s'il te plaît": "please", "s'il te plait": "please", "il faut": "we need", acheter: "buy", lait: "milk", pain: "bread",
      oeufs: "eggs", "œufs": "eggs", beurre: "butter", fromage: "cheese", riz: "rice", pommes: "apples", et: "and", du: "", de: "", des: "", le: "", la: "", les: "" } },
];

// A few whole words in other scripts (Hindi and Tamil), for the demo.
const SCRIPT_WORDS: Record<string, string> = {
  "दूध": "milk", "नमक": "salt", "चीनी": "sugar", "चावल": "rice", "अंडे": "eggs", "दही": "curd", "प्याज": "onions",
  "रास्ते में": "on the way", "खरीद लें": "buy", "खरीदो": "buy", "लाना": "bring", "चाहिए": "needed", "और": "and", "खत्म": "finished",
  "பால்": "milk", "தயிர்": "curd", "அரிசி": "rice", "முட்டை": "eggs", "வேண்டும்": "needed", "தக்காளி": "tomatoes",
};

export type Translation = { language: string; english: string; confidence: number };

/** Detects Tanglish, Hinglish, Hindi or Tamil words and returns the message in English. */
export function toEnglish(message: string, keepWords: string[] = []): Translation {
  // The family's own words (and their spellings: "pal" for "paal") are never translated.
  const keep = new Set(keepWords.map(spellingKey));
  let english = message;
  let language = "English";

  for (const [word, en] of Object.entries(SCRIPT_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    if (english.includes(word)) {
      english = english.split(word).join(en);
      language = /[஀-௿]/.test(word) ? "Tamil" : "Hindi";
    }
  }
  const swap = (dict: Record<string, string>, name: string) => {
    let hit = false;
    for (const [word, en] of Object.entries(dict).sort((a, b) => b[0].length - a[0].length)) {
      if (keep.has(spellingKey(word))) continue;         // the family's own words stay as typed
      const re = new RegExp(`(^|[^\\p{L}])${word}(?=$|[^\\p{L}])`, "giu");
      if (re.test(english)) {
        english = english.replace(re, (_m, pre) => `${pre}${en}`);
        hit = true;
      }
    }
    if (hit && language === "English") language = name;
  };
  swap(TANGLISH, "Tanglish");
  swap(HINGLISH, "Hinglish");
  for (const lang of EUROPEAN) if (language === "English" && lang.marker.test(english)) swap(lang.words, lang.name);
  english = english.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  // Hindi and Tamil put the verb last ("on the way salt buy"): put it first, as English does.
  if (language === "Hindi" || language === "Tamil") {
    const verb = english.match(/^(.*?)\s*\b(buy|bring)$/i);
    if (verb) {
      const way = /\bon the way\b/i.test(verb[1]);
      english = `${verb[2]} ${verb[1].replace(/\bon the way\b/i, "").trim()}${way ? " on the way" : ""}`.replace(/\s{2,}/g, " ");
    }
  }
  if (language === "English" || english === message) return { language: "English", english: message, confidence: 1 };
  // "X needed" reads better as English word order for the rules ("tomatoes finished" is fine either way).
  return { language, english, confidence: /\bna\b/i.test(message) ? 0.55 : 0.9 };
}

// ---------------------------------------------------------------------------
// Reading sentences (stands in for extractActions)

const FILLER_END = /\s+(?:on\s+(?:the|your|ur)\s+way(?:\s+(?:home|back))?|on\s+the\s+way|(?:for|before)\s+(?:dinner|lunch|breakfast|tonight|tomorrow|the weekend)|tonight|today|tomorrow|later|please|pls|plz|too|as well|also|from\s+the\s+(?:shop|shops|store)|when\s+you\s+can|if\s+you\s+can|if\s+you're\s+passing|thanks|thx)\s*$/i;

function cleanItem(raw: string): string {
  let s = raw.trim().replace(/^[\s,.:;!-]+|[\s,.:;!?-]+$/g, "");
  for (let i = 0; i < 4; i++) s = s.replace(FILLER_END, "");
  s = s.replace(/^(?:also\s+|and\s+|some\s+|a\s+|an\s+|the\s+|more\s+|any\s+|few\s+|a\s+few\s+|bit\s+of\s+|a\s+bit\s+of\s+)+/i, "");
  return s.trim();
}

const QTY = /^(\d+(?:\.\d+)?\s*(?:kg|g|l|ml|litres?|packs?|packets?|bags?|bottles?|tins?|cans?|boxes?|jars?|loaves|loaf|dozen)?(?:\s+of)?)\s+(.+)$/i;

function splitItems(text: string): { name: string; quantity: string | null }[] {
  return text.split(/\s*(?:,|\band\b|&|\+)\s*/i).map(cleanItem).filter(Boolean)
    .filter((p) => p.split(/\s+/).length <= 4 && /\p{L}/u.test(p))
    .map((p) => {
      const q = p.match(QTY);
      return q ? { name: cleanItem(q[2]), quantity: q[1].replace(/\s+of$/i, "") } : { name: p, quantity: null };
    });
}

/** Things the demo treats as shoppable, so "the party is over" isn't read as "buy party". */
export function looksShoppable(name: string, known: string[]): boolean {
  const key = normalise(name);
  const knownKeys = new Set(known.map(normalise));
  if ([...itemVariants(key)].some((v) => knownKeys.has(v))) return true;
  return GROCERY.some((g) => key.includes(g));
}
const GROCERY = ["milk", "bread", "egg", "rice", "dal", "oil", "salt", "sugar", "tea", "coffee", "flour", "atta", "onion",
  "tomato", "potato", "chilli", "garlic", "ginger", "curd", "yoghurt", "yogurt", "butter", "cheese", "paneer", "ghee",
  "chicken", "fish", "meat", "lamb", "veg", "fruit", "banana", "apple", "lemon", "lime", "coriander", "spinach", "juice",
  "water", "biscuit", "cereal", "pasta", "soap", "shampoo", "toothpaste", "roll", "tissue", "nappies", "detergent",
  "masala", "spice", "leaves", "cream", "honey", "jam", "nuts", "snack", "crisps", "chocolate", "wine", "beer", "flower"];

/** Reads one sentence-like message into list actions, the way the local AI is asked to. */
export function extractActions(message: string, known: string[] = []): ExtractedActions {
  const out: ExtractedActions = { add: [], bought: [], remove: [], preferences: [] };
  const text = message.replace(/[“”]/g, '"').replace(/’/g, "'");
  const clauses = text.split(/\s*(?:[.;!?\n]+|,\s*(?:and\s+|but\s+|also\s+)?(?=(?:we|i|can|could|pls|please|get|buy|pick|grab|also|and)\b)|\s+but\s+|\s+also\s+)\s*/i).filter(Boolean);

  for (const raw of clauses) {
    const c = raw.trim();
    let m: RegExpMatchArray | null;

    // Outings: "the new Ramayana movie should be seen at iMax"
    if ((m = c.match(/^(?:the\s+)?(?:new\s+)?(.+?)\s+(?:should|must|has to|needs to)\s+be\s+(?:seen|watched|booked|done|had|eaten)\s+(?:at|in)\s+(?:the\s+)?(.+)$/i))) {
      const item = cleanItem(m[1].replace(/^new\s+/i, ""));
      out.add.push({ name: item, quantity: null });
      out.preferences.push({ item, shop: tidyShopName(m[2]) });
      continue;
    }
    // Preferences: "eggs are better in Waitrose", "flowers are good at the florists", "get flowers from the florist"
    if ((m = c.match(/^(?:the\s+)?(.+?)\s+(?:is|are)\s+(?:much\s+|way\s+)?(?:better|cheaper|best|good|nicer|fresher|great)\s+(?:in|at|from)\s+(?:the\s+)?(.+)$/i))
      || (m = c.match(/^always\s+(?:get|buy)\s+(?:the\s+)?(.+?)\s+(?:from|at)\s+(?:the\s+)?(.+)$/i))) {
      out.preferences.push({ item: cleanItem(m[1]), shop: tidyShopName(cleanItem(m[2])) });
      continue;
    }
    // Bought
    if ((m = c.match(/^(?:i\s+|i've\s+|we\s+|we've\s+)?(?:got|bought|picked\s+up|have\s+got|grabbed)\s+(?:the\s+|some\s+)?(.+)$/i))) {
      out.bought.push(...splitItems(m[1]).map((x) => x.name));
      continue;
    }
    // No longer needed
    if ((m = c.match(/^(?:we\s+)?(?:don'?t|do\s+not|no\s+longer)\s+need\s+(?:the\s+|any\s+)?(.+)$/i))
      || (m = c.match(/^(?:cancel|forget|scratch|skip)\s+(?:the\s+)?(.+)$/i))) {
      out.remove.push(...splitItems(m[1]).map((x) => x.name));
      continue;
    }
    // Run out: "we're out of rice", "no more eggs", "rice is over", "tomatoes are finished"
    if ((m = c.match(/(?:all\s+)?out\s+of\s+(?:the\s+)?(.+)$/i)) || (m = c.match(/\b(?:ran|run)\s+out\s+of\s+(?:the\s+)?(.+)$/i))
      || (m = c.match(/\bno\s+more\s+(.+)$/i))) {
      out.add.push(...splitItems(m[1]));
      continue;
    }
    if ((m = c.match(/^(?:the\s+|our\s+)?(.+?)\s+(?:is|are|has|have)\s+(?:all\s+)?(?:over|finished|gone|empty|run out|used up|all gone)$/i))) {
      const items = splitItems(m[1]).filter((x) => looksShoppable(x.name, known));
      out.add.push(...items);
      continue;
    }
    // Requests: "can you pick up milk on the way home", "we need bread", "grab some lemons"
    if ((m = c.match(/\b(?:pick\s+up|get|buy|grab|bring|need|needs|want|wants|add)\s+(?:us\s+|me\s+)?(.+)$/i))) {
      // "milk from Waitrose and flour from Costco": each shop goes with its own items, for this trip.
      const wanted = cleanItem(m[1]);   // drop "on the way home" etc. first, so "from Waitrose" ends the text
      const parts = splitByShop(wanted) ?? [{ text: wanted, shop: null }];
      for (const part of parts) out.add.push(...splitItems(part.text).map((i) => ({ ...i, shop: part.shop ? tidyShopName(part.shop) : null })));
      continue;
    }
  }
  // An item someone says they bought isn't also an add.
  const boughtKeys = new Set(out.bought.map(normalise));
  out.add = out.add.filter((a) => !boughtKeys.has(normalise(a.name)));
  return out;
}

// ---------------------------------------------------------------------------
// Proposing a shop for Needs review items (stands in for proposeShop)

export type DemoShop = { id: string; name: string; categories: string[]; example_items: string[] };
const HINTS: [RegExp, string[], string][] = [
  [/(?:masala|spice|dal|lentil|atta|paneer|ghee|curry|chilli|okra|coriander|jaggery|tamarind|turmeric|cumin|mustard seed|basmati|papad|pickle)/i, ["Indian grocer"], "Indian cooking staple"],
  [/(?:paracetamol|ibuprofen|plaster|medicine|tablet|toothpaste|toothbrush|shampoo|conditioner|deodorant|sun ?cream|vitamin|razor|cotton|nappies|wipes|soap)/i, ["Boots"], "Pharmacy and toiletries"],
  [/(?:salmon|wine|olive|avocado|prosecco|cheese board|flowers|truffle|sourdough|smoked)/i, ["Waitrose"], "Fresh and finer foods"],
  [/(?:lemon|lime|coffee|tea\b|sugar|kitchen roll|milk|bread|egg|butter|yoghurt|cheese|chicken|pasta|cereal|juice|crisps|biscuit|roll|tissue|bleach|detergent|bin bag|foil|apple|banana|potato|onion|tomato|lettuce|cucumber|carrot)/i, ["Tesco"], "Everyday supermarket item"],
];
export function proposeShop(item: string, shops: DemoShop[]): { shopId: string | null; confidence: number; reason: string } {
  for (const [re, names, reason] of HINTS) {
    if (!re.test(item)) continue;
    const shop = shops.find((s) => names.some((n) => s.name.toLowerCase() === n.toLowerCase()));
    if (shop) return { shopId: shop.id, confidence: 0.72, reason };
  }
  return { shopId: null, confidence: 0, reason: "Not sure which shop sells this" };
}

// ---------------------------------------------------------------------------
// Short replies to non-shopping messages (stands in for chatReply)

const ZONES: [RegExp, string, string][] = [
  [/chennai|madras|mumbai|bombay|delhi|bangalore|bengaluru|india|kolkata|hyderabad|kerala|pune/i, "Asia/Kolkata", "India"],
  [/colombo|sri lanka/i, "Asia/Colombo", "Sri Lanka"],
  [/dubai|uae|abu dhabi/i, "Asia/Dubai", "Dubai"],
  [/singapore|kuala lumpur|malaysia/i, "Asia/Singapore", "Singapore"],
  [/new york|boston|us east/i, "America/New_York", "New York"],
  [/california|san francisco|los angeles|seattle/i, "America/Los_Angeles", "California"],
  [/toronto/i, "America/Toronto", "Toronto"],
  [/sydney|melbourne|australia/i, "Australia/Sydney", "Sydney"],
  [/london|uk|here/i, "Europe/London", "London"],
];

/** A short answer only when the bot is the right one to answer; "" means stay quiet. */
export function chatReply(message: string, ctx: { toBot: boolean }, now = new Date()): string {
  const t = message.toLowerCase();
  if (/\b(?:time|clock)\b/.test(t) && /\b(?:what|what's|whats)\b/.test(t)) {
    const zone = ZONES.find(([re]) => re.test(t));
    if (zone) {
      const time = now.toLocaleTimeString("en-GB", { timeZone: zone[1], hour: "2-digit", minute: "2-digit" });
      const day = now.toLocaleDateString("en-GB", { timeZone: zone[1], weekday: "long" });
      return `It's ${time} on ${day} in ${zone[2]}.`;
    }
  }
  if (/\b(?:what(?:'s| is) the date|what day is it|today's date)\b/.test(t)) {
    return `It's ${now.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long" })}.`;
  }
  if (ctx.toBot) {
    if (/\b(?:thanks|thank you|thx|cheers)\b/.test(t)) return "";
    if (/\b(?:who are you|what are you|are you a bot)\b/.test(t)) return "I'm ShoppingSync, the family's shopping list helper. Send \"help\" to see what I can do.";
    if (/\?$/.test(t.trim())) return "I only look after the shopping list, so I'm not the right one to ask. Send \"help\" to see what I can do.";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Setup chat (stands in for readList and guessShopItems)

/** Names in a sentence: "we mostly go to Tesco and the Indian shop, sometimes Boots". */
export function readList(kind: "shops" | "items", text: string): string[] {
  const english = toEnglish(text).english.replace(/\b(?:please|pls|plz|thanks)\b/gi, " ");
  const cleaned = english
    .replace(/\b(?:we|i|usually|mostly|normally|generally|go to|shop at|buy from|get (?:stuff|things) from|sometimes|occasionally|also|too|as well|the one near us|near us|nearby|for|our|my)\b/gi, ",")
    .replace(/\bthe\s+indian\s+(?:shop|store)\b/gi, "Indian grocer");
  return cleaned.split(/\s*(?:,|\band\b|&|\bor\b|\.|;)\s*/i)
    .map((p) => p.replace(/^(?:the|a|an|some)\s+/i, "").trim())
    .filter((p) => p && /\p{L}/u.test(p) && p.split(/\s+/).length <= (kind === "shops" ? 3 : 4));
}

const SHOP_GUESSES: [RegExp, string[], string[]][] = [
  [/indian|asian|desi|tamil|south indian/i, ["rice", "dal", "curry leaves", "paneer", "spices", "atta"], ["spices", "lentils"]],
  [/boots|superdrug|chemist|pharmacy/i, ["paracetamol", "toothpaste", "shampoo", "plasters", "vitamins"], ["medicine", "toiletries"]],
  [/tesco|sainsbury|asda|morrisons|co-?op|aldi|lidl|iceland/i, ["milk", "bread", "eggs", "fruit", "veg", "cereal"], ["groceries", "household"]],
  [/waitrose|m&s|marks/i, ["fresh fruit", "fish", "ready meals", "flowers", "wine"], ["fresh food"]],
  [/costco|makro|booker/i, ["toilet roll", "rice", "kitchen roll", "nappies", "detergent"], ["bulk"]],
  [/butcher/i, ["chicken", "lamb", "mince"], ["meat"]],
  [/florist/i, ["flowers", "plants"], ["flowers"]],
  [/baker/i, ["bread", "cakes", "pastries"], ["bakery"]],
  [/fish/i, ["salmon", "prawns", "cod"], ["fish"]],
];
export function guessShopItems(shop: string): { examples: string[]; categories: string[]; confidence: number } {
  const hit = SHOP_GUESSES.find(([re]) => re.test(shop));
  return hit ? { examples: hit[1], categories: hit[2], confidence: 0.75 } : { examples: [], categories: [], confidence: 0 };
}

// ---------------------------------------------------------------------------
// Context window (stands in for readWindow)

/** "do we have eggs?", "any milk left?", "is bread on the list?", "did anyone get rice?" -> the item. */
function itemAsked(text: string): string | null {
  const t = toEnglish(text).english.trim().replace(/^(?:hey|hi|ok|so|um+)[\s,!]+/i, "").replace(/\s+on\s+the\s+list(?=[\s?!.]*$)/i, "");
  const m =
    t.match(/^(?:do|did|have)\s+(?:we|you|u)\s+(?:still\s+)?(?:have|got|need)\s+(?:any\s+|some\s+|enough\s+)?(.+?)[\s?!.]*$/i) ??
    t.match(/^(?:is|are)\s+there\s+(?:any\s+|some\s+)?(.+?)(?:\s+(?:left|at home|in the fridge))?[\s?!.]*$/i) ??
    t.match(/^any\s+(.+?)\s+left[\s?!.]*$/i) ??
    t.match(/^(?:is|are)\s+(?:the\s+)?(.+?)\s+on\s+the\s+list[\s?!.]*$/i) ??
    t.match(/^did\s+(?:anyone|anybody|someone|you)\s+(?:get|buy|pick up|grab)\s+(?:the\s+|some\s+)?(.+?)[\s?!.]*$/i);
  const item = m?.[1]?.replace(/\s+(?:left|at home|in the fridge|already)$/i, "").trim();
  return item && item.split(/\s+/).length <= 3 ? item : null;
}
const SAYS_NO = /^(?:no|nope|nah|not really|none|we'?re out|all gone|finished|it'?s finished|over)\b/i;
const SAYS_YES = /^(?:yes|yeah|yep|yup|we do|plenty|loads|there'?s some)\b/i;

const HOLDING = /^(?:i\s+)?(?:need to|have to|will|'ll|gotta|let me|lemme)?\s*(?:check|look|see)\b|^(?:not sure|dunno|don'?t know|one sec|hang on|wait)\b/i;
const NO_ITEM = /^(?:no|no more|zero)\s+(.+?)[\s.!]*$|^(?:we'?re\s+)?out of\s+(.+?)[\s.!]*$|^(.+?)\s+(?:is|are)\s+(?:finished|over|gone)[\s.!]*$/i;

export function readWindow(input: WindowInput, known: string[] = []): WindowReading {
  const r: WindowReading = { add: [], bought: [], remove: [], preferences: [], list_question: null, question_about: null, setup_answer: { kind: "none", names: [] }, reply: "", answered: [], track_question: false };
  const last = input.messages.at(-1);
  if (!last) return r;
  const text = last.text.replace(/\s*\(in English: .*\)$/, "");
  const english = toEnglish(text).english.trim();
  const listed = (item: string) => input.list.some((i) => normalise(i.item) === normalise(item));
  const needIt = (item: string) => { if (!listed(item)) r.add.push({ name: item, quantity: null, shop: null }); };

  const asked = itemAsked(text);
  if (asked) {
    r.list_question = asked;
    r.question_about = /\bon\s+the\s+list\b|\bdid\s+(?:anyone|anybody|someone|you)\b/i.test(text) ? "list" : "home";
    r.track_question = r.question_about === "home";
    return r;
  }
  if (HOLDING.test(english)) return r;

  // The latest unanswered question about an item, asked by someone else.
  const open = [...input.unanswered_questions].reverse().find((q) => q.from !== last.from && itemAsked(q.text));
  const no = english.match(NO_ITEM);
  if (no) {
    const item = (no[1] ?? no[2] ?? no[3]).trim();
    needIt(item);
    const q = [...input.unanswered_questions].reverse().find((x) => normalise(itemAsked(x.text) ?? "") === normalise(item));
    if (q) r.answered.push(q.id);
    return r;
  }
  if (SAYS_NO.test(english) || SAYS_YES.test(english)) {
    if (open && last.replies_to !== "the bot") {
      if (SAYS_NO.test(english)) needIt(itemAsked(open.text)!);
      r.answered.push(open.id);
      return r;
    }
    if (input.setup_question && /^(?:no|nope|nah|not really|none)[\s.!]*$/i.test(english)) r.setup_answer = { kind: "skip", names: [] };
    return r;
  }

  if (input.setup_question) {
    const kind = /\bshops\b/i.test(input.setup_question) ? "shops" : "items";
    const names = readList(kind, text);
    if (names.length) { r.setup_answer = { kind, names }; return r; }
  }

  const ex = extractActions(english, known);
  Object.assign(r, { add: ex.add, bought: ex.bought, remove: ex.remove, preferences: ex.preferences });
  if (!ex.add.length && !ex.bought.length && !ex.remove.length && !ex.preferences.length) {
    r.reply = chatReply(text, { toBot: last.to_bot });
  }
  return r;
}
