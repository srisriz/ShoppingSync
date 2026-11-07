/**
 * The demo page's AI: runs the bot's own AI tasks (lib/ai.ts, same prompts) on Qwen
 * hosted by Groq. Only these fixed tasks, with short text and a rate limit, so it
 * can't be used as a general-purpose AI. The demo falls back to its built-in
 * stand-in whenever this isn't available.
 */
import { chatReply, extractActions, guessShopItems, proposeShop, readList, readShopAnswer, readWindow, toEnglish, type AiShop, type WindowInput } from "@/lib/ai";
import { GROQ_MODEL, groqConfigured, groqJson } from "@/lib/ai-groq";

export const dynamic = "force-dynamic";

const MAX_TEXT = 300;
const PER_VISITOR_PER_MIN = 40;
const ALL_PER_MIN = 400;

// Best-effort limits (per server instance): plenty for a demo, stops scripted abuse.
const hits = new Map<string, number[]>();
let all: number[] = [];
function allowed(ip: string): boolean {
  const now = Date.now(), minute = now - 60_000;
  all = all.filter((t) => t > minute);
  const mine = (hits.get(ip) ?? []).filter((t) => t > minute);
  if (mine.length >= PER_VISITOR_PER_MIN || all.length >= ALL_PER_MIN) return false;
  mine.push(now);
  all.push(now);
  hits.set(ip, mine);
  if (hits.size > 5000) hits.clear();
  return true;
}

const str = (x: unknown, max = MAX_TEXT) => String(x ?? "").slice(0, max);
const strs = (x: unknown, n: number, max = 60) => (Array.isArray(x) ? x : []).slice(0, n).map((v) => str(v, max));

export async function GET() {
  return Response.json({ configured: groqConfigured(), model: GROQ_MODEL });
}

export async function POST(req: Request) {
  if (!groqConfigured()) return Response.json({ error: "not configured" }, { status: 503 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (!allowed(ip)) return Response.json({ error: "busy" }, { status: 429 });

  const body = (await req.json().catch(() => ({}))) as { task?: string; args?: Record<string, unknown> };
  const a = body.args ?? {};
  const started = Date.now();
  try {
    let result: unknown;
    switch (body.task) {
      case "toEnglish":
        result = await toEnglish(str(a.text), strs(a.keepWords, 60, 40), groqJson);
        break;
      case "extractActions":
        result = await extractActions(str(a.text), groqJson);
        break;
      case "chatReply": {
        const ctx = (a.ctx ?? {}) as { members?: unknown; toBot?: unknown };
        result = await chatReply(str(a.text), str(a.sender, 40), { members: strs(ctx.members, 12, 40), toBot: !!ctx.toBot }, new Date(), groqJson);
        break;
      }
      case "proposeShop": {
        const shops = (Array.isArray(a.shops) ? a.shops : []).slice(0, 15).map((s: Record<string, unknown>): AiShop => ({
          id: str(s.id, 80), name: str(s.name, 40), categories: strs(s.categories, 10), example_items: strs(s.example_items, 30), notes: null,
        }));
        const past = (Array.isArray(a.past) ? a.past : []).slice(0, 40).map((p: Record<string, unknown>) => ({ item: str(p.item, 40), shop: str(p.shop, 40) }));
        const same = (Array.isArray(a.same) ? a.same : []).slice(0, 20).map((g: unknown) => strs(g, 6, 40));
        result = await proposeShop(str(a.item, 60), shops, past, same, groqJson);
        break;
      }
      case "readList":
        result = await readList(a.kind === "shops" ? "shops" : "items", str(a.text), groqJson);
        break;
      case "readShopAnswer":
        result = await readShopAnswer(str(a.text), groqJson);
        break;
      case "readWindow": {
        const w = (a.input ?? {}) as Record<string, unknown>;
        const input: WindowInput = {
          messages: (Array.isArray(w.messages) ? w.messages : []).slice(-12).map((m: Record<string, unknown>) => ({
            from: str(m.from, 40), text: str(m.text),
            replies_to: m.replies_to === "the bot" ? "the bot" : m.replies_to === "someone else" ? "someone else" : null,
            to_bot: !!m.to_bot,
          })),
          members: strs(w.members, 12, 40),
          setup_question: w.setup_question ? str(w.setup_question, 200) : null,
          list: (Array.isArray(w.list) ? w.list : []).slice(0, 60).map((i: Record<string, unknown>) => ({ item: str(i.item, 60), shop: str(i.shop, 40) })),
        };
        result = await readWindow(input, groqJson);
        break;
      }
      case "guessShopItems":
        result = await guessShopItems(str(a.shop, 40), groqJson);
        break;
      default:
        return Response.json({ error: "unknown task" }, { status: 400 });
    }
    return Response.json({ result, model: GROQ_MODEL, ms: Date.now() - started });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message.slice(0, 200) : "failed" }, { status: 502 });
  }
}
