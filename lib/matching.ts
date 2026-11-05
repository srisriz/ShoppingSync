/**
 * Rules-only shop matching, shared by the web page and the WhatsApp listener.
 * No AI here: unknown items return null and land in "Needs review".
 *
 * Synonyms ("paal" = "milk") are pairs of words the family uses interchangeably.
 * The list keeps the word that was typed; synonyms only affect matching:
 *  - an item's OWN rule always wins ("paal" -> Indian grocer even if "milk" -> Tesco)
 *  - otherwise a synonym's rule or example item is used
 *  - synonyms count as the same item for duplicates and "got"/"done"
 */

export type MatchRule = { item_key: string; shop_id: string };
export type MatchShop = { id: string; example_items: string[]; categories: string[] };
export type SynonymPair = { word_a: string; word_b: string };

/** Each word -> every word in its synonym group (pairs join transitively). */
export type SynonymGroups = Map<string, Set<string>>;

/** Same normalisation as the database's generated item_key column. */
export function normalise(name: string): string {
  return name.trim().toLowerCase();
}

/** Singular and plural count as the same item ("egg" = "eggs", "tomato" = "tomatoes"). */
export function itemVariants(key: string): Set<string> {
  return new Set([key, key.replace(/(es|s)$/, ""), `${key}s`, `${key}es`]);
}

/**
 * Tanglish/Hinglish spelling key: the same word spelt different ways in English
 * letters gets the same key. "paal" / "pal" / "paall" -> "pal";
 * "thayir" / "tayir" -> "tayir"; "muttai" / "mutai" -> "mutai".
 */
export function spellingKey(word: string): string {
  return normalise(word)
    .replace(/zh/g, "l")                    // "pazham" ~ "palam"
    .replace(/([bcdgjkpst])h/g, "$1")       // th -> t, dh -> d, kh -> k ...
    .replace(/ee/g, "i").replace(/oo/g, "u")
    .replace(/([aeiou])y([aeiou])/g, "$1$2")  // "thayir" ~ "thair"
    .replace(/(.)\1+/g, "$1");               // double letters: "paal" -> "pal", "muttai" -> "mutai"
}

/** One letter added, removed or changed? Only for words of 5+ letters, so "card" never becomes "curd". */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Finds the saved family word a typed word is a spelling of ("pal" -> "paal"), or null. */
export function findFamilyWord(word: string, groups?: SynonymGroups): string | null {
  if (!groups || groups.size === 0) return null;
  for (const v of itemVariants(normalise(word))) if (groups.has(v)) return v;
  const key = spellingKey(word);
  for (const known of groups.keys()) {
    const kk = spellingKey(known);
    if (kk === key || oneEditApart(kk, key)) return known;
  }
  return null;
}

/** Joins pairs into groups: thayir = curd and curd = yoghurt -> {thayir, curd, yoghurt}. */
export function buildSynonymGroups(pairs: SynonymPair[]): SynonymGroups {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const { word_a, word_b } of pairs) {
    const a = normalise(word_a), b = normalise(word_b);
    if (!a || !b) continue;
    parent.set(find(a), find(b));
  }
  const byRoot = new Map<string, Set<string>>();
  for (const word of parent.keys()) {
    const root = find(word);
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root)!.add(word);
  }
  const groups: SynonymGroups = new Map();
  for (const members of byRoot.values()) for (const w of members) groups.set(w, members);
  return groups;
}

/** The synonym group for an item (plurals included), excluding nothing; empty if it has none. */
function synonymsOf(key: string, groups?: SynonymGroups): Set<string> {
  const out = new Set<string>();
  if (!groups) return out;
  // Exact (with plurals) first; otherwise a Tanglish spelling of a family word ("pal" -> "paal").
  const known = findFamilyWord(key, groups);
  if (!known) return out;
  out.add(key);
  for (const w of groups.get(known) ?? []) for (const wv of itemVariants(w)) out.add(wv);
  return out;
}

/** The item itself plus all its synonyms, with plurals. */
export function equivalents(key: string, groups?: SynonymGroups): Set<string> {
  return new Set([...itemVariants(key), ...synonymsOf(key, groups)]);
}

/** Same item? Plurals and synonyms count ("paal" = "milk" = "milks"). */
export function sameItem(a: string, b: string, groups?: SynonymGroups): boolean {
  return equivalents(a, groups).has(b) || equivalents(b, groups).has(a);
}

/**
 * Picks a shop, in order:
 * 1. a saved rule for this exact item (plurals count)
 * 2. a saved rule for one of its synonyms
 * 3. the item or a synonym is one of a shop's example items
 * 4. the item or a synonym is named as one of a shop's categories
 * Shops should be passed in priority order, so the lowest number wins.
 */
export function suggestShop(key: string, rules: MatchRule[], shops: MatchShop[], groups?: SynonymGroups): string | null {
  const own = itemVariants(key);
  const all = equivalents(key, groups);
  const matches = (list: string[]) => list.some((x) => all.has(normalise(x)));
  return (
    rules.find((r) => own.has(r.item_key))?.shop_id ??
    rules.find((r) => all.has(r.item_key))?.shop_id ??
    shops.find((s) => matches(s.example_items))?.id ??
    shops.find((s) => matches(s.categories))?.id ??
    null
  );
}

/** Groups as lists for display or for the AI: [["paal", "milk"], ["thayir", "curd", "yoghurt"]]. */
export function groupList(groups: SynonymGroups): string[][] {
  return [...new Set(groups.values())].map((g) => [...g]);
}

/**
 * True when every word in the message is a known family word or simple list glue
 * ("Paal and thayir needed"), so no translation is needed.
 */
export function onlyKnownWords(text: string, groups: SynonymGroups): boolean {
  const glue = new Set(["and", "&", "need", "needed", "required", "wanted", "please", "pls", "get", "buy",
    "more", "extra", "some", "the", "a", "an", "x", "also", "too", "got", "cancel",
    // Tanglish / Hinglish "need"
    "venum", "vendum", "veenum", "venam", "chahiye", "chaiye", "chahie", "aur",
    // ran out
    "out", "of", "finished", "over", "empty", "khatam", "theernduchu", "theerndhuchu", "mudinjiduchu", "illa"]);
  const words = text.toLowerCase().replace(/#\w+/g, " ").split(/[\s,;.!?+\-\n]+/).filter(Boolean);
  if (words.length === 0) return false;
  let known = 0;
  for (const w of words) {
    if (/^\d+$/.test(w) || glue.has(w)) continue;
    if (!findFamilyWord(w, groups)) return false;
    known++;
  }
  return known > 0;
}

// ---------------------------------------------------------------------------
// Space-separated lists: "pal coffee", "milk eggs bread"

export type KnownItems = { rules: MatchRule[]; shops: MatchShop[]; groups?: SynonymGroups };

/** Is this whole name something the list already knows: a saved rule, a shop's example item, or a family word? */
export function isKnownItem(name: string, known: KnownItems): boolean {
  const variants = itemVariants(normalise(name));
  return (
    known.rules.some((r) => variants.has(r.item_key)) ||
    known.shops.some((s) => s.example_items.some((x) => variants.has(normalise(x)))) ||
    !!findFamilyWord(name, known.groups)
  );
}

/**
 * Splits "pal coffee" into ["pal", "coffee"] only when EVERY piece is a known item.
 * Known multi-word items stay whole ("kallu uppu", "rock salt"); a name that is known
 * as a whole is never split; anything with an unknown word stays as typed
 * ("paneer tikka", "kitchen roll"). Returns null when the name should stay one item.
 */
export function splitKnownWords(name: string, known: KnownItems): string[] | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return null;
  if (isKnownItem(name, known)) return null;

  // best[i] = a way to cover the first i words with known items (longest pieces first).
  const best: (string[] | null)[] = Array(words.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < words.length; i++) {
    if (!best[i]) continue;
    for (let len = Math.min(3, words.length - i); len >= 1; len--) {
      const piece = words.slice(i, i + len).join(" ");
      if (!best[i + len] && isKnownItem(piece, known)) best[i + len] = [...best[i]!, piece];
    }
  }
  const parts = best[words.length];
  return parts && parts.length >= 2 ? parts : null;
}
