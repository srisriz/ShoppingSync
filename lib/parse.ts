/**
 * Turns a family chat message into list actions, using simple rules (no AI).
 *
 *   "need milk, eggs and 2 loaves of bread"  -> add milk, add eggs, add bread (qty 2 loaves)
 *   "got the bread and milk"                 -> mark bread and milk as bought
 *   "cancel eggs"                            -> remove eggs
 *   "on my way" / "ok" / "are you home?"     -> nothing (chatter)
 *
 * Anything that looks like an item is added; if no shop matches it goes to
 * "Unassigned" on the web page, where it can be moved or removed.
 */

export type ParsedAction =
  | { kind: "add"; name: string; quantity: string | null }
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
