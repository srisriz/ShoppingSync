/**
 * Qwen on Groq, for the website's demo. Server only: the key never reaches a browser.
 * The prompts are the bot's own (lib/ai.ts); only the way they reach a model differs.
 *
 * Settings (Vercel → Settings → Environment Variables):
 *   GROQ_API_KEY  (Secret)  your Groq key
 *   GROQ_MODEL    (optional) a Qwen model id from Groq's model list; default below
 */
import type { JsonLlm } from "./ai";

// Groq's only Qwen model (Preview) as of November 2026; override with GROQ_MODEL if their list changes.
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b";

export function groqConfigured(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/** Groq's OpenAI-style chat API in JSON mode. The schema is spelled out in the system prompt. */
export const groqJson: JsonLlm = async ({ system, user, schema, temperature }) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_tokens: 1500,          // room for a reasoning model to think before the JSON
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `${system}\n\nReply with one JSON object only, matching this JSON schema exactly:\n${JSON.stringify(schema)}`,
        },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  // Reasoning models may think out loud first; keep only the JSON.
  const text = (data.choices?.[0]?.message?.content ?? "{}").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}";
  return JSON.parse(json);
};
