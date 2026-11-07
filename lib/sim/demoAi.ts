/**
 * The demo's AI: Qwen on Groq through the website (/api/demo-ai, the bot's own prompts),
 * falling back to the small built-in stand-in (brain.ts) when that isn't available.
 * Each answer notes which one gave it, for the "What the bot did" panel.
 */
import type { BotAi } from "../bot/ports";
import type { DemoData } from "../bot/memory";
import * as brain from "./brain";

export type AiMode = "groq" | "standin";
type Note = (line: string) => void;

/** Asks the website's Groq route; throws if it's unavailable. */
async function remote<T>(task: string, args: unknown): Promise<{ result: T; ms: number; model: string }> {
  const res = await fetch("/api/demo-ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, args }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(res.status === 429 ? "busy" : res.status === 503 ? "not set up" : `error ${res.status}`);
  return res.json();
}

const pause = () => new Promise((r) => setTimeout(r, 300 + Math.random() * 300));

export function demoAi(data: DemoData, mode: () => AiMode, note: Note, onFallback?: (why: string) => void): BotAi {
  const known = () => [
    ...data.shops.flatMap((s) => s.example_items),
    ...data.rules.map((r) => r.item_name),
    ...data.synonyms.flatMap((p) => [p.word_a, p.word_b]),
  ];
  /** Groq first; the stand-in if Groq is off, busy or fails. */
  async function ask<T>(task: string, args: unknown, local: () => T): Promise<T> {
    if (mode() === "groq") {
      try {
        const r = await remote<T>(task, args);
        note(`↳ answered by ${r.model.replace(/^.*\//, "")} on Groq (${(r.ms / 1000).toFixed(1)}s)`);
        return r.result;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        note(`↳ Groq unavailable (${why}); the built-in stand-in answered`);
        onFallback?.(why);
      }
    } else {
      note("↳ answered by the built-in stand-in");
    }
    await pause();
    return local();
  }
  return {
    toEnglish: (text, keepWords) => ask("toEnglish", { text, keepWords }, () => brain.toEnglish(text, keepWords)),
    extractActions: (text) => ask("extractActions", { text }, () => brain.extractActions(text, known())),
    chatReply: (text, sender, ctx) => ask("chatReply", { text, sender, ctx }, () => brain.chatReply(text, { toBot: ctx.toBot })),
    proposeShop: (item, shops, past, same) => ask("proposeShop", { item, shops, past, same }, () => {
      const p = brain.proposeShop(item, shops);
      return { isItem: true, shopId: p.shopId, confidence: p.confidence, reason: p.reason };
    }),
    readList: (kind, text) => ask("readList", { kind, text }, () => brain.readList(kind, text)),
    readShopAnswer: (text) => ask("readShopAnswer", { text }, () => ({ shops: brain.readList("shops", text), items: [] })),
    guessShopItems: (shop) => ask("guessShopItems", { shop }, () => brain.guessShopItems(shop)),
    readWindow: (input) => ask("readWindow", { input }, () => brain.readWindow(input, known())),
  };
}
