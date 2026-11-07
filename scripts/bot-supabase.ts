/**
 * The bot's data, for one group, in Supabase (used by the WhatsApp listener).
 * Sent lists are remembered in a small local file so "Done" works after a restart.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BotItem, BotShop, BotStore, ChatWindow, Onboarding, ParkedInput, QuestionInput } from "../lib/bot/ports";
import type { SummaryItem } from "../lib/info";

const ITEM_COLUMNS = "id, name, item_key, quantity, shop_id, requested_by, status, created_at, bought_at";
const SHOP_COLUMNS = "id, name, example_items, categories, priority, notes";

// Which items each sent list contained, so "Done" clears exactly those.
const LISTS_FILE = ".wa-lists.json";
type SentLists = Record<string, { itemIds: string[]; sentAt: string }>;
function readSentLists(): SentLists {
  try { return existsSync(LISTS_FILE) ? (JSON.parse(readFileSync(LISTS_FILE, "utf8")) as SentLists) : {}; }
  catch { return {}; }
}

let warned = false;
function warnNoWindow(message: string) {
  if (warned) return;
  warned = true;
  console.error(`! Context window not saved (${message}). Run supabase/migrations/0010_chat_window.sql.`);
}

/** Deletes context windows nobody has added to for a while, in every group. */
export async function clearStaleWindows(db: SupabaseClient, idleMs: number): Promise<number> {
  const before = new Date(Date.now() - idleMs).toISOString();
  const { data, error } = await db.from("families").update({ chat_window: null })
    .not("chat_window", "is", null).lt("chat_window->>lastAt", before).select("id");
  if (error) return 0;
  return data?.length ?? 0;
}

export function supabaseStore(db: SupabaseClient, fid: string): BotStore {
  const now = () => new Date().toISOString();
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  return {
    async shops() {
      const { data } = await db.from("shops").select(SHOP_COLUMNS).eq("family_id", fid).order("priority").order("name");
      return (data ?? []) as BotShop[];
    },
    async rules() {
      const { data } = await db.from("rules").select("item_key, item_name, shop_id").eq("family_id", fid).order("created_at", { ascending: false });
      return data ?? [];
    },
    async synonymPairs() {
      const { data } = await db.from("synonyms").select("word_a, word_b").eq("family_id", fid);
      return data ?? [];
    },
    async members() {
      const { data } = await db.from("members").select("display_name").eq("family_id", fid);
      return (data ?? []).map((m) => m.display_name as string);
    },
    async neededItems() {
      const { data } = await db.from("items").select(ITEM_COLUMNS).eq("family_id", fid).eq("status", "needed").order("created_at");
      return (data ?? []) as BotItem[];
    },
    async summaryItems(sinceIso) {
      const { data } = await db.from("items")
        .select("name, status, shop_id, requested_by, created_at, bought_at")
        .eq("family_id", fid)
        .or(`status.eq.needed,created_at.gte.${sinceIso},bought_at.gte.${sinceIso}`);
      return (data ?? []) as SummaryItem[];
    },

    async addItem(item) {
      const { data, error } = await db.from("items")
        .insert({ family_id: fid, ...item, source: "whatsapp" }).select(ITEM_COLUMNS).single();
      if (error) console.error(`    ✗ ${item.name}: ${error.message}`);
      return (data as BotItem | null) ?? null;
    },
    async updateItem(id, patch) {
      await db.from("items").update(patch).eq("id", id);
    },
    async setStatus(ids, status, opts) {
      const run = async (withBy: boolean) => {
        const change: Record<string, unknown> = { status, bought_at: status === "bought" ? now() : null };
        if (withBy) change.bought_by = status === "bought" ? opts?.by ?? null : null;
        let q = db.from("items").update(change).eq("family_id", fid).eq("status", "needed");
        if (ids !== "all") q = q.in("id", ids);
        if (opts?.shopId) q = q.eq("shop_id", opts.shopId);
        return q.select("id");
      };
      let res = await run(true);
      // Before migration 0009 there's no bought_by column: tick off without it.
      if (res.error && /bought_by/.test(res.error.message)) res = await run(false);
      return (res.data ?? []).map((r) => r.id as string);
    },
    async recentlyBought(sinceIso) {
      let res = await db.from("items").select("name, item_key, bought_at, bought_by")
        .eq("family_id", fid).eq("status", "bought").gte("bought_at", sinceIso).order("bought_at", { ascending: false }).limit(200);
      if (res.error && /bought_by/.test(res.error.message)) {
        res = await db.from("items").select("name, item_key, bought_at")
          .eq("family_id", fid).eq("status", "bought").gte("bought_at", sinceIso).order("bought_at", { ascending: false }).limit(200) as typeof res;
      }
      return (res.data ?? []).map((r) => ({ name: r.name, item_key: r.item_key, bought_at: r.bought_at, bought_by: (r as { bought_by?: string | null }).bought_by ?? null }));
    },
    async deleteItems(ids) {
      await db.from("items").delete().in("id", ids);
    },
    async moveNeededByKey(itemKey, shopId) {
      await db.from("items").update({ shop_id: shopId }).eq("family_id", fid).eq("status", "needed").eq("item_key", itemKey);
    },

    async addShop(shop) {
      const { data, error } = await db.from("shops").insert({ family_id: fid, ...shop }).select(SHOP_COLUMNS).single();
      if (error) console.error(`    ✗ shop ${shop.name}: ${error.message}`);
      return (data as BotShop | null) ?? null;
    },
    async updateShop(id, patch) {
      await db.from("shops").update(patch).eq("id", id);
    },
    async getOnboarding() {
      const { data } = await db.from("families").select("onboarding").eq("id", fid).maybeSingle();
      return (data?.onboarding as Onboarding | null) ?? null;
    },
    async setOnboarding(o) {
      await db.from("families").update({ onboarding: o }).eq("id", fid);
    },
    // The context window lives in families.chat_window (migration 0010) and is deleted when it closes.
    async getWindow() {
      const { data, error } = await db.from("families").select("chat_window").eq("id", fid).maybeSingle();
      if (error) { warnNoWindow(error.message); return null; }
      return (data?.chat_window as ChatWindow | null) ?? null;
    },
    async setWindow(w) {
      const { error } = await db.from("families").update({ chat_window: w }).eq("id", fid);
      if (error) warnNoWindow(error.message);
    },
    async upsertRules(rules) {
      await db.from("rules").upsert(rules.map((r) => ({ family_id: fid, ...r })), { onConflict: "family_id,item_key" });
    },
    async addSynonym(a, b) {
      const { error } = await db.from("synonyms").insert({ family_id: fid, word_a: a, word_b: b });
      if (error) console.error(`    ✗ synonym ${a} = ${b}: ${error.message}`);
      return !error;
    },
    async clearProposals(ids) {
      if (ids === "unproposed") {
        await db.from("items").update({ proposed_at: null })
          .eq("family_id", fid).eq("status", "needed").is("shop_id", null).is("proposed_shop_id", null);
      } else if (ids.length) {
        await db.from("items").update({ proposed_at: null, proposed_shop_id: null }).in("id", ids);
      }
    },

    async addQuestion(messageId, input: QuestionInput) {
      await db.from("ai_tasks").insert({ family_id: fid, message_id: messageId, kind: "question", status: "queued", input });
    },
    async openQuestions(quotedId, windowMs) {
      let q = db.from("ai_tasks").select("id, input").eq("family_id", fid).eq("kind", "question").eq("status", "queued");
      q = quotedId ? q.eq("message_id", quotedId).gte("created_at", since(windowMs)) : q.gte("created_at", since(windowMs));
      const { data } = await q.order("created_at", { ascending: false });
      return (data ?? []) as { id: string; input: QuestionInput }[];
    },
    async closeTask(id, result) {
      await db.from("ai_tasks").update({ status: "done", result, updated_at: now() }).eq("id", id);
    },

    async park(messageId, input: ParkedInput) {
      await db.from("ai_tasks").insert({ family_id: fid, message_id: messageId, kind: "extract", input });
    },
    async parkedMessages(limit) {
      const { data } = await db.from("ai_tasks").select("id, input")
        .eq("family_id", fid).eq("kind", "extract").eq("status", "queued").order("created_at").limit(limit);
      return (data ?? []) as { id: string; input: ParkedInput }[];
    },
    async setTaskQueued(id) {
      await db.from("ai_tasks").update({ status: "queued", updated_at: now() }).eq("id", id);
    },
    async setTaskRunning(id) {
      await db.from("ai_tasks").update({ status: "running", updated_at: now() }).eq("id", id);
    },

    async rememberList(messageId, itemIds) {
      const lists = readSentLists();
      lists[messageId] = { itemIds, sentAt: now() };
      const recent = Object.entries(lists).sort((a, b) => b[1].sentAt.localeCompare(a[1].sentAt)).slice(0, 30);
      writeFileSync(LISTS_FILE, JSON.stringify(Object.fromEntries(recent), null, 2));
    },
    async listItemIds(messageId) {
      return readSentLists()[messageId]?.itemIds;
    },

    async itemsAwaitingProposal(limit) {
      const { data } = await db.from("items").select("id, name")
        .eq("family_id", fid).eq("status", "needed").is("shop_id", null).is("proposed_at", null)
        .order("created_at").limit(limit);
      return data ?? [];
    },
    async saveProposal(id, p) {
      await db.from("items").update({
        proposed_shop_id: p.shopId, proposal_confidence: p.confidence, proposal_reason: p.reason, proposed_at: now(),
      }).eq("id", id);
    },
  };
}
