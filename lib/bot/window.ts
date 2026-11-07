/**
 * The context window. A message that is a clear action ("milk", "got eggs", "list")
 * is handled straight away. Anything else (a question, "No", half a sentence) is kept
 * here with the few messages around it, and the AI reads them together, so "No" after
 * "do we have eggs?" is understood as an answer to that question.
 *
 * Ordinary messages drop out once the bot acts or asks, after 10 messages (the
 * oldest go first), or after 5 quiet minutes. An unanswered question stays until
 * someone answers it or the shopping list is cleared (it had items since the
 * question was asked, and now it's empty), however long that takes.
 */
import type { Bot, ChatWindow, WindowMessage, WindowQuestion } from "./ports";

export const WINDOW_IDLE_MS = 5 * 60 * 1000;
export const WINDOW_MAX = 10;
export const BOT_NAME = "ShoppingSync";

/**
 * The window as it should be now: chatter older than 5 quiet minutes dropped, and
 * questions dropped once the list has been cleared. Null when nothing is left.
 */
export function tidyWindow(w: ChatWindow, nowMs: number, neededCount: number): ChatWindow | null {
  const quiet = nowMs - Date.parse(w.lastAt) > WINDOW_IDLE_MS;
  const messages = quiet ? [] : w.messages;
  let questions = w.questions ?? [];
  if (neededCount > 0) questions = questions.map((q) => (q.sawItems ? q : { ...q, sawItems: true }));
  else questions = questions.filter((q) => !q.sawItems);
  if (!messages.length && !questions.length) return null;
  return { ...w, messages, questions };
}

function sameWindow(a: ChatWindow | null, b: ChatWindow | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The open window, tidied (and saved if that changed anything), or null if there isn't one. */
export async function currentWindow(bot: Bot): Promise<ChatWindow | null> {
  const w = await bot.store.getWindow();
  if (!w) return null;
  const tidy = tidyWindow(w, bot.now().getTime(), (await bot.store.neededItems()).length);
  if (!sameWindow(w, tidy)) {
    await bot.store.setWindow(tidy);
    const dropped = (w.questions?.length ?? 0) - (tidy?.questions?.length ?? 0);
    if (dropped) bot.log(`context window: the list was cleared, so ${dropped} unanswered question${dropped === 1 ? "" : "s"} dropped`);
    if (w.messages.length && !tidy?.messages.length) bot.log("context window: chat dropped after 5 quiet minutes");
  }
  return tidy;
}

/** Updates the unanswered questions: removes the answered ones, adds a new one. */
export async function updateQuestions(bot: Bot, answered: string[], add: WindowQuestion | null): Promise<void> {
  const w = await bot.store.getWindow();
  if (!w) return;
  const kept = (w.questions ?? []).filter((q) => !answered.includes(q.id));
  if (kept.length < (w.questions?.length ?? 0)) bot.log(`context window: ${(w.questions?.length ?? 0) - kept.length} question(s) answered`);
  const questions = add ? [...kept, add].slice(-MAX_QUESTIONS) : kept;
  if (add) bot.log(`context window: keeping "${add.text}" until it's answered or the list is cleared`);
  await bot.store.setWindow({ ...w, questions });
}
export const MAX_QUESTIONS = 5;

/** Adds a message, opening a window if none is open. */
export async function addToWindow(bot: Bot, msg: WindowMessage): Promise<ChatWindow> {
  const w = await currentWindow(bot);
  const next: ChatWindow = w
    ? { ...w, lastAt: msg.at, messages: [...w.messages, msg].slice(-WINDOW_MAX) }
    : { openedAt: msg.at, lastAt: msg.at, messages: [msg], questions: [] };
  await bot.store.setWindow(next);
  return next;
}

/** The bot's own reply joins an open window, so the AI knows what it already said. */
export async function noteBotLine(bot: Bot, text: string): Promise<void> {
  const w = await currentWindow(bot);
  if (!w) return;
  const at = bot.now().toISOString();
  await bot.store.setWindow({ ...w, lastAt: at, messages: [...w.messages, { id: `bot-${at}`, sender: BOT_NAME, text, at, replyTo: null, toBot: false }].slice(-WINDOW_MAX) });
}

/** The conversation so far is dealt with: its chat goes, unanswered questions stay. */
export async function closeWindow(bot: Bot, why: string): Promise<void> {
  const w = await bot.store.getWindow();
  if (!w) return;
  const questions = w.questions ?? [];
  await bot.store.setWindow(questions.length ? { ...w, messages: [] } : null);
  bot.log(`context window: chat cleared (${why})${questions.length ? `; ${questions.length} unanswered question${questions.length === 1 ? "" : "s"} kept` : ""}`);
}

/** "any milk left?", "do we have eggs", "who's going to Tesco?": a question opens a window. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) ||
    /^(?:(?:hey|hi|hello|ok|oh|so|um+)[\s,!]+)*(?:do|does|did|is|are|was|were|have|has|can|could|should|shall|will|would|what|what's|whats|where|when|who|why|how|which|any(?:one|body)?)\b/i.test(t);
}
