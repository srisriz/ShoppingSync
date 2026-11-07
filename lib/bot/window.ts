/**
 * The context window. A message that is a clear action ("milk", "got eggs", "list")
 * is handled straight away. Anything else (a question, "No", half a sentence) is kept
 * here with the few messages around it, and the AI reads them together, so "No" after
 * "do we have eggs?" is understood as an answer to that question.
 *
 * It closes (and is deleted) once the bot acts or asks something, after 10 messages
 * (the oldest drop off), or after 5 quiet minutes.
 */
import type { Bot, ChatWindow, WindowMessage } from "./ports";

export const WINDOW_IDLE_MS = 5 * 60 * 1000;
export const WINDOW_MAX = 10;
export const BOT_NAME = "ShoppingSync";

/** The open window, or null if there isn't one (or it went quiet and is deleted now). */
export async function currentWindow(bot: Bot): Promise<ChatWindow | null> {
  const w = await bot.store.getWindow();
  if (!w) return null;
  if (bot.now().getTime() - Date.parse(w.lastAt) > WINDOW_IDLE_MS) {
    await bot.store.setWindow(null);
    bot.log("context window: closed after 5 quiet minutes");
    return null;
  }
  return w;
}

/** Adds a message, opening a window if none is open. */
export async function addToWindow(bot: Bot, msg: WindowMessage): Promise<ChatWindow> {
  const w = await currentWindow(bot);
  const next: ChatWindow = w
    ? { ...w, lastAt: msg.at, messages: [...w.messages, msg].slice(-WINDOW_MAX) }
    : { openedAt: msg.at, lastAt: msg.at, messages: [msg] };
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

export async function closeWindow(bot: Bot, why: string): Promise<void> {
  if (!(await bot.store.getWindow())) return;
  await bot.store.setWindow(null);
  bot.log(`context window: closed (${why})`);
}

/** "any milk left?", "do we have eggs", "who's going to Tesco?": a question opens a window. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) ||
    /^(?:(?:hey|hi|hello|ok|oh|so|um+)[\s,!]+)*(?:do|does|did|is|are|was|were|have|has|can|could|should|shall|will|would|what|what's|whats|where|when|who|why|how|which|any(?:one|body)?)\b/i.test(t);
}
