/**
 * "Done" commands from the family group.
 *
 *   "Done"              -> (as a reply to a list) tick off everything on that list
 *   "done costco"       -> tick off everything on the Costco list
 *   "Done at Tesco ✅"  -> same, for Tesco
 *   "done indian"       -> "Indian grocer", when that's the only shop it fits
 */

export type DoneCommand = { shop: string | null };

const DONE = /^(?:all\s+)?done(?:\s+(?:(?:at|with|from|in|for)\s+)?(?:the\s+)?(.*?))?[\s!.✅👍]*$/i;

/** Returns the command if the message is a "done" message, else null. */
export function parseDone(text: string): DoneCommand | null {
  const m = text.replace(/#\w+/g, "").trim().match(DONE);
  if (!m) return null;
  const shop = (m[1] ?? "").replace(/\s+(?:shop|list|store)$/i, "").trim();
  return { shop: shop || null };
}

export type ShopMatch<S> =
  | { kind: "one"; shop: S }
  | { kind: "several"; shops: S[] }
  | { kind: "none" };

/**
 * Finds the shop the family meant: exact name first (ignoring case and
 * punctuation), then a shop whose name starts with or contains the words.
 */
export function matchShopName<S extends { name: string }>(said: string, shops: S[]): ShopMatch<S> {
  const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const target = clean(said);
  if (!target) return { kind: "none" };

  const exact = shops.filter((s) => clean(s.name) === target);
  if (exact.length === 1) return { kind: "one", shop: exact[0] };

  const starts = shops.filter((s) => clean(s.name).startsWith(target));
  if (starts.length === 1) return { kind: "one", shop: starts[0] };

  const contains = shops.filter((s) => clean(s.name).includes(target) || target.includes(clean(s.name)));
  if (contains.length === 1) return { kind: "one", shop: contains[0] };

  const options = starts.length > 1 ? starts : contains;
  return options.length > 1 ? { kind: "several", shops: options } : { kind: "none" };
}

/**
 * "Add shop Lidl", "add a new shop: Aldi", "new shop M&S".
 * Optional items after a colon or "for" become example items:
 *   "add shop Lidl: fruit, veg, bread"  -> shop Lidl, example items fruit, veg, bread
 */
export type AddShopCommand = { name: string; exampleItems: string[] };

const ADD_SHOP = /^(?:please\s+)?(?:add|create|new)\s+(?:a\s+)?(?:new\s+)?(?:shop|store)\s*:?\s+(.+?)[\s!.]*$/i;

export function parseAddShop(text: string): AddShopCommand | null {
  const m = text.replace(/#\w+/g, "").trim().match(ADD_SHOP);
  if (!m) return null;
  // The shop name, then optional example items after ":", " - " or " for ".
  const [rawName, ...rest] = m[1].split(/\s*(?::|\s-\s|\s+for\s+)\s*/i);
  const rawItems = rest.join(", ");
  const name = rawName.replace(/^["'“‘]|["'”’]$/g, "").trim();
  if (!name || name.length > 40) return null;
  const exampleItems = rawItems.split(/\s*(?:,|;|\band\b|&)\s*/i).map((x) => x.trim()).filter(Boolean);
  return { name, exampleItems };
}

/**
 * "paal means milk", "paal = milk", "thayir is the same as curd", "curd same as yoghurt".
 * (Pairs can also be added or removed on the family profile page.)
 * Saves a synonym pair: the family can use either word.
 */
export type SynonymCommand = { a: string; b: string };

const SYNONYM = /^(.{1,30}?)\s*(?:\bmeans\b|=|\bis\s+the\s+same\s+as\b|\bsame\s+as\b)\s*(.{1,30}?)[\s.!]*$/i;
// Chat words that are never item names ("that means yes", "it means a lot").
const NOT_ITEMS = /\b(?:that|this|it|which|what|yes|no|you|i|we|he|she|they|so|nothing|everything|something|lot|time|now)\b/i;

export function parseSynonym(text: string): SynonymCommand | null {
  const m = text.replace(/#\w+/g, "").trim().match(SYNONYM);
  if (!m) return null;
  const clean = (x: string) => x.replace(/^["'“‘]|["'”’]$/g, "").trim();
  const a = clean(m[1]), b = clean(m[2]);
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  if (!/\p{L}/u.test(a) || !/\p{L}/u.test(b)) return null;              // words, not sums like "2 + 2 = 4"
  if (NOT_ITEMS.test(a) || NOT_ITEMS.test(b)) return null;
  if (a.split(/\s+/).length > 3 || b.split(/\s+/).length > 3) return null; // item names, not sentences
  return { a, b };
}

/**
 * One or more pairs in a message:
 *   "paal means milk and thayir means curd", "paal = milk, thayir = curd", one pair per line.
 * Returns null unless every part of the message is a pair, so ordinary lists are never misread.
 */
export function parseSynonyms(text: string): SynonymCommand[] | null {
  const single = parseSynonym(text);
  if (single) return [single];
  const parts = text.split(/\n|;|,|\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const pairs = parts.map(parseSynonym);
  return pairs.every((p): p is SynonymCommand => p !== null) ? pairs : null;
}

/**
 * "Replace Riz with Rice", "replace riz by rice", "rename riz to rice", "change riz to rice".
 * Renames matching items on the current list; duplicates under the same shop are then merged.
 */
export type ReplaceCommand = { from: string; to: string };

const REPLACE = /^(?:replace|rename|change|correct)\s+(.{1,40}?)\s+(?:with|by|to|into|as|->|→|=>)\s+(.{1,40}?)[\s.!]*$/i;

export function parseReplace(text: string): ReplaceCommand | null {
  const m = text.replace(/#\w+/g, "").trim().match(REPLACE);
  if (!m) return null;
  const clean = (x: string) => x.replace(/^["'“‘]|["'”’]$/g, "").replace(/^(?:the|all)\s+/i, "").trim();
  const from = clean(m[1]), to = clean(m[2]);
  if (!from || !to || !/\p{L}/u.test(from) || !/\p{L}/u.test(to)) return null;
  if (from === to) return null;
  if (from.split(/\s+/).length > 4 || to.split(/\s+/).length > 4) return null; // item names, not sentences
  return { from, to };
}

/**
 * Tanglish "X na Y" / "X-nu Y" / "X endral Y" ("riz na rice" = "riz means rice").
 * "na" can also mean "don't" in Hindi ("doodh na lao"), so this is only ever a
 * suggestion: the bot asks before saving it.
 */
const TANGLISH_MEANS = /^(.{1,30}?)\s*(?:-\s*na|\s+na|-\s*nu|\s+nu|\s+endral|\s+enral|\s+ennaa?)\s+(.{1,30}?)[\s.!?]*$/i;
// Hindi verbs that follow "na" = "don't" ("doodh na lao", "na karo"): never a synonym.
const HINDI_DONT = /^(?:lao|lana|laana|lena|laiye|karo|kharido|kharidna|mangao|mangana|dena|do|bhejo|chahiye)$/i;

export function parseTanglishMeans(text: string): SynonymCommand | null {
  const m = text.replace(/#\w+/g, "").trim().match(TANGLISH_MEANS);
  if (!m) return null;
  const a = m[1].trim(), b = m[2].trim();
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  if (!/\p{L}/u.test(a) || !/\p{L}/u.test(b)) return null;
  if (a.split(/\s+/).length > 2 || b.split(/\s+/).length > 2) return null;
  if (NOT_ITEMS.test(a) || NOT_ITEMS.test(b) || HINDI_DONT.test(b)) return null;
  return { a, b };
}
