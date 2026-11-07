/**
 * Builds the shopping list as a WhatsApp message: each shop in priority order,
 * followed by its items, with "Needs review" items last.
 *
 *   🛒 *Shopping list* · Wed 4 Nov, 22:19
 *
 *   *Tesco*
 *   • milk (2)
 *   • eggs
 *
 *   *Needs review*
 *   • kitchen roll
 */

export type ListShop = { id: string; name: string };
export type ListItem = { name: string; quantity: string | null; shop_id: string | null };

/** Messages that ask the bot for the list, rather than adding an item called "list". */
const LIST_REQUEST = /^(?:(?:send|share|show)\s+(?:me\s+)?(?:the\s+)?)?(?:shopping\s+)?list(?:\s+please|\s+pls)?[\s?!.]*$/i;

export function isListRequest(text: string): boolean {
  return LIST_REQUEST.test(text.replace(/#\w+/g, "").trim());
}

/** "Done", "all done", "done!" — clears a list when sent as a reply to it. */
export function isDone(text: string): boolean {
  return /^(?:all\s+)?done[\s!.✅👍]*$/i.test(text.trim());
}

/**
 * The line at the bottom of the list: a "Did you know…" picked at random, either a
 * tip about what the bot can do or a fun fact. Tips use the family's own shops and
 * items where they can ("done Lidl", "got paneer").
 */
type TipContext = { shop: string; item: string; otherShop: string };
const TIPS: ((c: TipContext) => string)[] = [
  (c) => `you can reply *got ${c.item}* to tick off one item?`,
  (c) => `*done ${c.shop}* ticks off everything from ${c.shop} in one go?`,
  () => `replying *Done* to this message ticks off everything on it?`,
  () => `*review* sends a link to sort out anything in Needs review?`,
  () => `*summary* shows what was added and ticked off today?`,
  () => `you can teach me family words, like *paal means milk*?`,
  () => `*replace Riz with Rice* fixes a name on the list?`,
  (c) => `*${c.item} is better at ${c.otherShop}* moves it there for good?`,
  (c) => `*${c.item} from ${c.otherShop}* puts it there just for this trip?`,
  () => `*add shop Lidl* adds a new shop to your list?`,
  () => `*cancel eggs* takes something off without ticking it?`,
  () => `you can write in Tanglish or Hinglish, like *paal venum* or *doodh chahiye*?`,
  () => `*help* shows everything I can do?`,
];
const FACTS = [
  "the first thing ever scanned with a barcode at a till was a pack of Wrigley's gum, in Ohio in 1974?",
  "bananas are berries, but strawberries aren't?",
  "the shopping trolley was invented in 1937 by Sylvan Goldman, an Oklahoma supermarket owner?",
  "peanuts aren't really nuts, but legumes like lentils and chickpeas?",
  "Tesco's name comes from T. E. Stockwell, a tea supplier, plus the first two letters of Cohen, after founder Jack Cohen?",
  "cashews grow hanging underneath a fruit called the cashew apple?",
  "turmeric gets its bright yellow colour from a compound called curcumin?",
  "ghee keeps for months without a fridge, because cooking it removes almost all the water?",
  "honey is so low in water and so acidic that it can keep for decades if it's sealed?",
  "most carrots were purple or yellow until orange ones became popular in the 1600s?",
  "rice is the main food for over half the people in the world?",
  "an avocado only starts to ripen once it's been picked?",
];

/** A random "Did you know…" line. `random` is swappable so tests can pick a fixed one. */
export function didYouKnow(shops: ListShop[], items: ListItem[], random: () => number = Math.random): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length) % xs.length];
  const withItems = shops.filter((s) => items.some((i) => i.shop_id === s.id));
  const shop = withItems[0]?.name ?? shops[0]?.name ?? "Tesco";
  const otherShop = shops.find((s) => s.name !== shop)?.name ?? "Waitrose";
  const item = items.find((i) => i.shop_id)?.name ?? items[0]?.name ?? "milk";
  const text = random() < 0.6 ? pick(TIPS)({ shop, item, otherShop }) : pick(FACTS);
  return `💡 _Did you know ${text}_`;
}

export function formatListMessage(shops: ListShop[], items: ListItem[], now = new Date(), random: () => number = Math.random): string {
  const when = now.toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
  });
  const header = `🛒 *Shopping list* · ${when}`;
  if (items.length === 0) return `${header}\n\nNothing to buy right now 🎉`;

  const line = (i: ListItem) => `• ${i.name}${i.quantity ? ` (${i.quantity})` : ""}`;
  const known = new Set(shops.map((s) => s.id));
  const sections: string[] = [];

  for (const shop of shops) {
    const list = items.filter((i) => i.shop_id === shop.id);
    if (list.length) sections.push(`*${shop.name}*\n${list.map(line).join("\n")}`);
  }
  const review = items.filter((i) => !i.shop_id || !known.has(i.shop_id));
  if (review.length) sections.push(`*Needs review*\n${review.map(line).join("\n")}`);

  const count = items.length === 1 ? "1 item" : `${items.length} items`;
  return `${header} · ${count}\n\n${sections.join("\n\n")}\n\n` +
    didYouKnow(shops, items, random);
}
