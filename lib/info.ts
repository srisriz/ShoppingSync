/**
 * Fixed answers the app writes itself (no AI), so they are always accurate:
 *   "help" / "what are your features?"  -> what the bot can do
 *   "summary" / "what happened today?"  -> today's list activity (the chat itself is never kept)
 */

const stripMentions = (text: string) => text.replace(/@\S+/g, " ").replace(/#\w+/g, " ").replace(/\s+/g, " ").trim();

const HELP =
  /^(?:(?:hey|hi|hello|ok)\s+)?(?:shopping\s*sync\s*,?\s*|bot\s*,?\s*)?(?:help(?:\s+me)?|\?|commands|features|(?:what\s+(?:are|r)\s+(?:your|ur|the)\s+(?:features|commands))|(?:what\s+can\s+(?:you|u|i)\s+(?:do|say|send|ask))|(?:what\s+do\s+(?:you|u)\s+do)|(?:how\s+(?:does|do)\s+(?:this|it|you|the\s+bot)\s+work)|(?:how\s+do\s+i\s+use\s+(?:this|it|you|the\s+bot)))(?:\s+please)?[\s?!.]*$/i;

export function isHelpRequest(text: string): boolean {
  return HELP.test(stripMentions(text));
}

const SUMMARY =
  /\b(?:summary|summarise|summarize|summarising|summarizing|recap)\b|^(?:so\s+)?what(?:'s|\s+has)?\s+(?:been\s+)?happen(?:ed|ing)\s+(?:today|so\s+far)|^what\s+did\s+(?:i|we)\s+miss/i;

export function isSummaryRequest(text: string): boolean {
  const t = stripMentions(text);
  return t.split(/\s+/).length <= 12 && SUMMARY.test(t);
}

export const HELP_TEXT = [
  "🛒 *ShoppingSync can:*",
  '• *Add*: "milk, eggs and bread", "paal venum", "we\'re out of rice"',
  '• *Tick off*: "got bread"; "done Tesco" for a shop; reply "Done" to a list for everything',
  '• *Remove*: "cancel eggs"',
  '• *Fix a name*: "replace Riz with Rice"',
  '• *Show the list*: send "list"',
  '• *Today\'s activity*: send "summary"',
  '• *Add a shop*: "add shop Lidl"',
  '• *Same words*: "paal means milk"',
  '• *Preferences*: "eggs are better in Waitrose"',
  "",
  "Sentences, Tanglish and Hinglish work too; I'll ask before acting if I'm unsure.",
].join("\n");

/** Midnight today in the UK, as a UTC timestamp (works in GMT and BST). */
export function startOfTodayUk(now = new Date()): Date {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // "2026-11-05"
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  const ukHour = Number(new Date(guess).toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }));
  return new Date(guess - (ukHour % 24) * 3600 * 1000);
}

export type SummaryItem = {
  name: string;
  status: "needed" | "bought" | "removed";
  shop_id: string | null;
  requested_by: string[];
  created_at: string;
  bought_at: string | null;
};

/** Today's list activity as a WhatsApp message. Built only from the list, never from the chat. */
export function formatSummary(items: SummaryItem[], now = new Date()): string {
  const start = startOfTodayUk(now).getTime();
  const today = (iso: string | null) => !!iso && Date.parse(iso) >= start;
  const cap = (xs: string[], n = 12) => (xs.length > n ? [...xs.slice(0, n), `+${xs.length - n} more`] : xs).join(", ");

  const added = items.filter((i) => today(i.created_at))
    .map((i) => (i.requested_by[0] ? `${i.name} (${i.requested_by[0]})` : i.name));
  const bought = items.filter((i) => i.status === "bought" && today(i.bought_at)).map((i) => i.name);
  const review = items.filter((i) => i.status === "needed" && !i.shop_id).map((i) => i.name);
  const open = items.filter((i) => i.status === "needed").length;

  const lines = ["📋 *Today so far*"];
  if (added.length) lines.push(`• Added: ${cap(added)}`);
  if (bought.length) lines.push(`• Ticked off: ${cap(bought)}`);
  if (review.length) lines.push(`• Needs review: ${cap(review)}`);
  if (!added.length && !bought.length) lines.push("• No list activity yet today.");
  lines.push(`• On the list now: ${open === 1 ? "1 item" : `${open} items`}`);
  lines.push("", 'I don\'t keep the chat itself, only the shopping list. Send "list" for the full list.');
  return lines.join("\n");
}
