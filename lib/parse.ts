/**
 * Turns a family chat message into list actions, using simple rules (no AI).
 *
 *   "need milk, eggs and 2 loaves of bread"  -> add milk, add eggs, add bread (qty 2 loaves)
 *   "got the bread and milk"                 -> mark bread and milk as bought
 *   "cancel eggs"                            -> remove eggs
 *   "on my way" / "ok" / "are you home?"     -> nothing (chatter)
 *   "milk and yoghurt from Waitrose and almond flour from Costco"
 *                                            -> add milk + yoghurt (Waitrose), almond flour (Costco)
 *
 * Anything that looks like an item is added; if no shop matches it goes to
 * "Unassigned" on the web page, where it can be moved or removed.
 */

export type ParsedAction =
  /** shop: named in the message for this trip ("from Costco"); the bot decides if it's a real shop. */
  | { kind: "add"; name: string; quantity: string | null; shop?: string }
  | { kind: "bought"; name: string }
  | { kind: "remove"; name: string };

const CHATTER = new Set([
  "ok", "okay", "k", "kk", "thanks", "thank you", "thx", "ty", "yes", "no", "yep", "yeah", "nope",
  "lol", "haha", "sure", "done", "cool", "nice", "great", "fine", "bye", "hi", "hello", "hey",
  "on my way", "omw", "good morning", "good night", "love you", "see you", "will do", "noted",
]);

// Messages that start like this are conversation, whatever follows.
const CHATTER_START = /^(?:on\s+my\s+way|omw|running\s+late|be\s+home|home\s+(?:soon|in|at|by)|see\s+you|call\s+me|where\s+are|what\s+time|thanks|thank\s+you|good\s+(?:morning|night)|happy\s+)/i;

// "need", "we need", "can someone get", "please buy", "pick up some" ...
const ADD_PREFIX =
  /^(?:(?:can|could)\s+(?:someone|somebody|you|u)\s+)?(?:please\s+|pls\s+|plz\s+)?(?:we\s+)?(?:need(?:s)?|get|buy|pick\s+up|add|grab|bring)(?:\s+(?:some|a|an|the))?\s+/i;
const BOUGHT = /^(?:i\s+)?(?:got|bought|picked\s+up|have\s+got)\s+(?:the\s+|some\s+)?(.+)$/i;
const REMOVE = /^(?:cancel|remove|delete|scratch|(?:we\s+)?don'?t\s+need)\s+(?:the\s+|any\s+)?(.+)$/i;

// Running out means "buy more": "out of milk", "no more eggs", "we've run out of rice",
// "tomatoes are finished", "rice is over", Tanglish "thakkali theernduchu", Hinglish "cheeni khatam".
const RUN_OUT_PREFIX =
  /^(?:(?:we(?:'re|\s+are|'ve|\s+have)?|i(?:'m|\s+am|'ve|\s+have)?)\s+)?(?:(?:all\s+)?out\s+of|(?:run|ran)\s+out\s+of|no\s+more)\s+(?:the\s+)?(.+)$/i;
const RUN_OUT_SUFFIX =
  /^(?:the\s+)?(.+?)\s+(?:(?:is|are|has|have|got|been)\s+)*(?:(?:all\s+)?finished|over|empty|(?:run|ran)\s+out|used\s+up|all\s+gone|gone|khatam(?:\s+(?:ho\s+gaya|ho\s+gayi|hai))?|theernduchu|theerndhuchu|theernjiduchu|mudinjiduchu|mudinjuduchu|illa)$/i;

const UNITS = "x|kg|g|l|ltr|litres?|liters?|ml|packs?|packets?|bags?|bottles?|tins?|cans?|boxes?|jars?|loaf|loaves|dozen|bunch(?:es)?";
const LEADING_QTY = new RegExp(`^(\\d+(?:\\.\\d+)?\\s*(?:(?:${UNITS})\\b)?(?:\\s+of)?)\\s+(.+)$`, "i");
const TRAILING_QTY = /^(.+?)\s*(?:x\s*(\d+)|(\d+)\s*x)$/i;
// "extra milk", "more eggs", "2 more eggs", "another loaf"  ->  quantity "extra" or "+2"
const EXTRA_QTY = /^(?:(\d+)\s+)?(?:extra|more|another|additional)\s+(.+)$/i;

const MAX_WORDS = 5; // longer phrases are treated as conversation, not items

function tidy(part: string): string {
  return part
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "")    // bullets and "1." list markers
    .replace(/^(?:some|the|a|an)\s+/i, "")
    .replace(/\s+(?:please|pls|plz|too|as well)$/i, "")
    .replace(/[.!]+$/, "")
    .trim();
}

export type ParseResult = {
  actions: ParsedAction[];
  /** True when the message reads like a sentence the rules may not fully understand: worth asking the AI. */
  needsAi: boolean;
};

/**
 * Rules first. Short lists ("milk, eggs") are handled here with certainty.
 * Sentences ("can you pick up milk on the way home, we're out of eggs") are
 * flagged for the local AI, which reads the whole message.
 */
// Words that show a part is a sentence, not an item name.
const SENTENCE_WORDS = /\b(?:i|i'm|im|you|you're|we|we're|were|our|us|me|my|he|she|they|it's|is|are|was|be|been|will|can|could|would|should|have|has|had|do|does|did|on the way|way home|tonight|tomorrow|today|later|left|see|love|dinner|lunch|home|out of|run out|ran out|running|because|so|if|when|there|any)\b/i;

/**
 * Rules first, but only for messages that clearly read as a list
 * ("milk", "need milk, eggs and bread", "2 loaves of bread", "got the bread").
 * Anything that reads like a sentence ("can you pick up milk on the way home,
 * we're also out of eggs") is flagged for the local AI, which reads the whole message.
 */
export function parseMessageDetailed(text: string): ParseResult {
  // "eggs from Costco", "milk from Waitrose and flour from Costco", "Costco: eggs, ghee":
  // read each shop's part on its own, then tag its items with the shop.
  const byShop = splitByShop(text);
  if (byShop) {
    const actions: ParsedAction[] = [];
    let kind: ParsedAction["kind"] = "add";
    for (const [i, seg] of byShop.entries()) {
      const r = readWithoutShops(seg.text);
      if (r.needsAi) return { actions: [], needsAi: true };
      // "got milk from Tesco and eggs from Lidl": later parts share the first part's verb.
      if (i === 0 && r.actions[0]) kind = r.actions[0].kind;
      const ownVerb = /^\s*(?:and\s+|also\s+|then\s+)?(?:(?:can|could)\s+\S+\s+)?(?:please\s+)?(?:we\s+)?(?:need|get|buy|pick\s+up|add|grab|bring|got|bought|cancel|remove)\b/i.test(seg.text);
      for (const a of r.actions) {
        const k = i > 0 && !ownVerb ? kind : a.kind;
        if (k === "add") actions.push({ kind: "add", name: a.name, quantity: a.kind === "add" ? a.quantity : null, ...(seg.shop ? { shop: seg.shop } : {}) });
        else actions.push({ kind: k, name: a.name });
      }
    }
    return { actions, needsAi: actions.length === 0 };
  }
  return readWithoutShops(text);
}

/** Words that can follow "from"/"at" but are people, places or times, not shops. */
const NOT_A_SHOP = /^(?:home|work|school|the\s+office|office|night|lunch|dinner|breakfast|the\s+weekend|weekend|once|least|most|all|last|first|now|later|today|tonight|tomorrow|the\s+moment|you|me|us|them|him|her|mom|mum|mummy|dad|daddy|amma|appa|paati|thatha|nani|dadi|nana|anna|akka|thambi|bhaiya|didi|aunty|uncle|grandma|grandad|granny|the\s+kids|kids|\d.*)$/i;
const SHOP_HEADING_NOT = /^(?:we\s+)?(?:need|needs|to\s+buy|to\s+get|shopping(?:\s+list)?|list|buy|get|items?|todo|to\s*do|reminder|note|pls|please)$/i;

/**
 * Splits a message into parts by the shop each is for, or null if it names no shop that way.
 *   "milk and yoghurt from Waitrose and almond flour from Costco"
 *       -> [{ "milk and yoghurt", Waitrose }, { "and almond flour", Costco }]
 *   "Costco: eggs, ghee; Tesco: milk"  -> [{ "eggs, ghee", Costco }, { "milk", Tesco }]
 * Whether a name is really one of the family's shops is decided later, by the bot.
 */
export function splitByShop(text: string): { text: string; shop: string | null }[] | null {
  const body = text.replace(/#\w+/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!body) return null;

  // Leading form, one shop per line or per ";" part: "Costco: eggs, ghee", "at Tesco: milk".
  const chunks = body.split(/\n|;/).map((c) => c.trim()).filter(Boolean);
  const headed = chunks.map((c) => {
    const m = c.match(/^(?:(?:from|at)\s+)?([^:,]{2,30}):\s*(.+)$/i);
    if (!m) return null;
    const name = m[1].trim();
    if (SHOP_HEADING_NOT.test(name) || NOT_A_SHOP.test(name) || name.split(/\s+/).length > 3) return null;
    return { text: m[2], shop: name };
  });
  if (headed.some(Boolean)) return chunks.map((c, i) => headed[i] ?? { text: c, shop: null });

  // Trailing form: "... from Waitrose", "... at Costco", one or more times.
  const tag = /\s+(?:from|at)\s+(?:the\s+)?([\p{L}][\p{L}\p{N}'&.\-]*(?:\s+[\p{L}\p{N}'&.\-]+){0,2}?)(?=\s*(?:$|[,;.!?\n]|\s+(?:and|then|also|plus)\b))/giu;
  // "and almond flour from Costco": the joining word belongs to neither part.
  const trimJoin = (t: string) => t.trim().replace(/^(?:and|also|then|plus|&)\s+/i, "").trim();
  const parts: { text: string; shop: string | null }[] = [];
  let cursor = 0;
  for (const m of body.matchAll(tag)) {
    const name = m[1].replace(/[.!?]+$/, "").trim();
    if (NOT_A_SHOP.test(name)) continue;
    const before = body.slice(cursor, m.index);
    if (/\p{L}/u.test(before)) parts.push({ text: trimJoin(before), shop: name });
    cursor = m.index! + m[0].length;
  }
  if (parts.length === 0) return null;
  const rest = body.slice(cursor).replace(/^[\s,;.!?]+/, "");
  if (/\p{L}/u.test(rest)) parts.push({ text: trimJoin(rest), shop: null });
  return parts;
}

/** The rules without shop tags (see parseMessageDetailed). */
function readWithoutShops(text: string): ParseResult {
  const cleaned = text.replace(/#\w+/g, " ").replace(/[ \t]+/g, " ").trim();
  // "rice is over" vs "the party is over": these words are ambiguous, so let the AI decide (and confirm).
  if (/\b(?:over|gone|empty)[\s!.]*$/i.test(cleaned)) return { actions: [], needsAi: true };
  const actions = parseMessage(text);
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  if (words < 4 && actions.every((a) => !SENTENCE_WORDS.test(a.name))) {
    return { actions, needsAi: false };                         // "ok", "milk and eggs", "on my way"
  }

  // Parts the rules skipped as too long to be an item mean part of the message wasn't understood.
  const parts = cleaned.split(/\n|,|;|\s+and\s+|\s*&\s*|\s+\+\s+/i).map(tidy).filter(Boolean);
  const skippedLongPart = parts.some((p) => p.split(/\s+/).length > MAX_WORDS);
  const listLike = !skippedLongPart && actions.length > 0 && actions.every(
    (a) => a.name.split(/\s+/).length <= 4 && !SENTENCE_WORDS.test(a.name),
  );
  return listLike ? { actions, needsAi: false } : { actions: [], needsAi: true };
}

export function parseMessage(text: string): ParsedAction[] {
  let body = text.replace(/#\w+/g, " ").replace(/[ \t]+/g, " ").trim(); // drop hashtags like #test
  if (!body) return [];
  if (CHATTER_START.test(body)) return [];
  if (CHATTER.has(body.toLowerCase().replace(/[.!]+$/, ""))) return [];
  // A question without a request verb ("are you home?") is conversation.
  if (body.endsWith("?") && !ADD_PREFIX.test(body)) return [];
  body = body.replace(/\?+$/, "");

  let kind: ParsedAction["kind"] = "add";
  const ranOut = body.match(RUN_OUT_PREFIX) ?? body.match(RUN_OUT_SUFFIX);
  if (ranOut) body = ranOut[1];
  const bought = ranOut ? null : body.match(BOUGHT);
  const removed = bought || ranOut ? null : body.match(REMOVE);
  if (bought) { kind = "bought"; body = bought[1]; }
  else if (removed) { kind = "remove"; body = removed[1]; }
  else if (!ranOut) body = body.replace(ADD_PREFIX, "");
  // "milk and yoghurt needed", "eggs required please": the request word at the end
  body = body.replace(/\s+(?:is\s+|are\s+)?(?:needed|required|wanted|venum|vendum|veenum|chahiye|chaiye|chahie)(?:\s+(?:please|pls|plz))?[\s!.]*$/i, "");
  body = body.replace(/\s+aur\s+/gi, " and ");   // Hinglish "and"
  // A heading line such as "we need:" or "shopping list:" before the items.
  body = body.replace(/^(?:[^\n:]{0,30}:)\s*/, "");

  const actions: ParsedAction[] = [];
  for (const raw of body.split(/\n|,|;|\s+and\s+|\s*&\s*|\s+\+\s+/i)) {
    let part = tidy(raw);
    if (!part || !/\p{L}/u.test(part)) continue;               // emoji or numbers only
    if (CHATTER.has(part.toLowerCase())) continue;
    if (part.split(/\s+/).length > MAX_WORDS) continue;

    if (kind !== "add") {
      actions.push({ kind, name: part });
      continue;
    }
    let quantity: string | null = null;
    const extra = part.match(EXTRA_QTY);
    if (extra) {
      const name = tidy(extra[2].replace(/^of\s+/i, ""));      // "more of the good coffee" -> "good coffee"
      if (name) actions.push({ kind: "add", name, quantity: extra[1] ? `+${extra[1]}` : "extra" });
      continue;
    }
    const lead = part.match(LEADING_QTY);
    const trail = lead ? null : part.match(TRAILING_QTY);
    if (lead) { quantity = lead[1].replace(/\s+of$/i, ""); part = tidy(lead[2]); }
    else if (trail) { quantity = trail[2] ?? trail[3]; part = tidy(trail[1]); }
    if (part) actions.push({ kind: "add", name: part, quantity });
  }
  return actions;
}
