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

export function formatListMessage(shops: ListShop[], items: ListItem[], now = new Date()): string {
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
    `_Reply "got milk" for one item, "done Tesco" for a whole shop, or "Done" to this message for everything._`;
}
