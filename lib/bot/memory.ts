/**
 * The bot's data kept in memory, for the demo page. Same contract as the
 * Supabase store the WhatsApp listener uses; nothing is saved anywhere.
 */
import { normalise } from "../matching";
import type { SummaryItem } from "../info";
import type { BotItem, BotRule, BotShop, BotStore, Onboarding, ParkedInput, QuestionInput } from "./ports";
import type { SynonymPair } from "../matching";

export type DemoItem = BotItem & { proposed_shop_id: string | null; proposal_confidence: number | null; proposal_reason: string | null; proposed_at: string | null };
type Task = { id: string; kind: "question" | "extract"; status: "queued" | "running" | "done"; message_id: string; created_at: number; input: unknown; result?: unknown };

export type DemoData = {
  shops: BotShop[];
  rules: (BotRule & { origin: string; created_at: number })[];
  synonyms: SynonymPair[];
  members: string[];
  items: DemoItem[];
  tasks: Task[];
  lists: Record<string, string[]>;
  onboarding: Onboarding | null;
};

let seq = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function memoryStore(d: DemoData, now: () => Date = () => new Date()): BotStore {
  const iso = () => now().toISOString();
  const byPriority = (a: BotShop, b: BotShop) => a.priority - b.priority || a.name.localeCompare(b.name);
  return {
    async shops() { return [...d.shops].sort(byPriority); },
    async rules() { return [...d.rules].sort((a, b) => b.created_at - a.created_at); },
    async synonymPairs() { return [...d.synonyms]; },
    async members() { return [...d.members]; },
    async neededItems() {
      return d.items.filter((i) => i.status === "needed").sort((a, b) => a.created_at.localeCompare(b.created_at)).map((i) => ({ ...i, requested_by: [...i.requested_by] }));
    },
    async summaryItems(since) {
      return d.items.filter((i) => i.status === "needed" || i.created_at >= since || (i.bought_at ?? "") >= since) as SummaryItem[];
    },

    async addItem(item) {
      const row: DemoItem = {
        id: newId("item"), name: item.name, item_key: normalise(item.name), quantity: item.quantity, shop_id: item.shop_id,
        requested_by: item.requested_by, status: "needed", created_at: iso(), bought_at: null,
        proposed_shop_id: null, proposal_confidence: null, proposal_reason: null, proposed_at: null,
      };
      d.items.push(row);
      return { ...row };
    },
    async updateItem(id, patch) {
      const it = d.items.find((i) => i.id === id);
      if (!it) return;
      Object.assign(it, patch);
      if (patch.name) it.item_key = normalise(patch.name);
    },
    async setStatus(ids, status, opts) {
      const changed: string[] = [];
      for (const it of d.items) {
        if (it.status !== "needed") continue;
        if (ids !== "all" && !ids.includes(it.id)) continue;
        if (opts?.shopId && it.shop_id !== opts.shopId) continue;
        it.status = status;
        it.bought_at = status === "bought" ? iso() : null;
        changed.push(it.id);
      }
      return changed;
    },
    async deleteItems(ids) { d.items = d.items.filter((i) => !ids.includes(i.id)); },
    async moveNeededByKey(itemKey, shopId) {
      for (const it of d.items) if (it.status === "needed" && it.item_key === itemKey) it.shop_id = shopId;
    },

    async addShop(shop) {
      const row: BotShop = { id: newId("shop"), name: shop.name, example_items: shop.example_items, categories: [], priority: shop.priority, notes: null };
      d.shops.push(row);
      return { ...row };
    },
    async updateShop(id, patch) {
      const shop = d.shops.find((s) => s.id === id);
      if (shop) Object.assign(shop, patch);
    },
    async getOnboarding() { return d.onboarding ? { ...d.onboarding } : null; },
    async setOnboarding(o) { d.onboarding = { ...o }; },
    async upsertRules(rules) {
      for (const r of rules) {
        const key = normalise(r.item_name);
        d.rules = d.rules.filter((x) => x.item_key !== key);
        d.rules.push({ item_key: key, item_name: r.item_name, shop_id: r.shop_id, origin: r.origin, created_at: now().getTime() + seq++ });
      }
    },
    async addSynonym(a, b) { d.synonyms.push({ word_a: a, word_b: b }); return true; },
    async clearProposals(ids) {
      for (const it of d.items) {
        if (ids === "unproposed" ? it.status === "needed" && !it.shop_id && !it.proposed_shop_id : ids.includes(it.id)) {
          it.proposed_at = null;
          if (ids !== "unproposed") it.proposed_shop_id = null;
        }
      }
    },

    async addQuestion(messageId, input: QuestionInput) {
      d.tasks.push({ id: newId("task"), kind: "question", status: "queued", message_id: messageId, created_at: now().getTime(), input });
    },
    async openQuestions(quotedId, windowMs) {
      const from = now().getTime() - windowMs;
      return d.tasks
        .filter((t) => t.kind === "question" && t.status === "queued" && t.created_at >= from && (!quotedId || t.message_id === quotedId))
        .sort((a, b) => b.created_at - a.created_at)
        .map((t) => ({ id: t.id, input: t.input as QuestionInput }));
    },
    async closeTask(id, result) {
      const t = d.tasks.find((x) => x.id === id);
      if (t) { t.status = "done"; t.result = result; }
    },

    async park(messageId, input: ParkedInput) {
      d.tasks.push({ id: newId("task"), kind: "extract", status: "queued", message_id: messageId, created_at: now().getTime(), input });
    },
    async parkedMessages(limit) {
      return d.tasks.filter((t) => t.kind === "extract" && t.status === "queued").sort((a, b) => a.created_at - b.created_at)
        .slice(0, limit).map((t) => ({ id: t.id, input: t.input as ParkedInput }));
    },
    async setTaskQueued(id) { const t = d.tasks.find((x) => x.id === id); if (t) t.status = "queued"; },
    async setTaskRunning(id) { const t = d.tasks.find((x) => x.id === id); if (t) t.status = "running"; },

    async rememberList(messageId, itemIds) { d.lists[messageId] = itemIds; },
    async listItemIds(messageId) { return d.lists[messageId]; },

    async itemsAwaitingProposal(limit) {
      return d.items.filter((i) => i.status === "needed" && !i.shop_id && !i.proposed_at).slice(0, limit).map((i) => ({ id: i.id, name: i.name }));
    },
    async saveProposal(id, p) {
      const it = d.items.find((i) => i.id === id);
      if (!it) return;
      it.proposed_shop_id = p.shopId;
      it.proposal_confidence = p.confidence;
      it.proposal_reason = p.reason;
      it.proposed_at = iso();
    },
  };
}

/** A starting point for the demo: a family with four shops and a few family words. */
export function demoSeed(): DemoData {
  const shop = (id: string, name: string, priority: number, example_items: string[], categories: string[]): BotShop =>
    ({ id, name, priority, example_items, categories, notes: null });
  return {
    shops: [
      shop("tesco", "Tesco", 10, ["milk", "bread", "eggs", "butter", "yoghurt", "cheese", "chicken", "pasta", "bananas", "apples", "potatoes", "onions", "tomatoes", "toilet roll", "washing up liquid", "cereal", "orange juice", "coffee", "tea", "sugar", "lemons"], ["dairy", "bakery", "household"]),
      shop("indian", "Indian grocer", 20, ["rice", "dal", "curry leaves", "ghee", "paneer", "atta", "coriander", "green chillies", "okra", "garam masala", "turmeric", "curd", "mustard seeds", "jaggery"], ["spices", "lentils"]),
      shop("boots", "Boots", 30, ["paracetamol", "toothpaste", "shampoo", "plasters", "sun cream", "vitamins"], ["medicine", "toiletries"]),
      shop("waitrose", "Waitrose", 40, ["smoked salmon", "olive oil", "avocados", "flowers", "sourdough"], []),
    ],
    rules: [],
    synonyms: [{ word_a: "paal", word_b: "milk" }, { word_a: "thayir", word_b: "curd" }, { word_a: "arisi", word_b: "rice" }],
    members: ["Amma", "Appa", "Ravi", "Priya"],
    items: [],
    tasks: [],
    lists: {},
    onboarding: { step: "done", shopIds: [], index: 0, guess: null, askedAt: new Date().toISOString() }, // set up already
  };
}

/** A brand-new group: no shops yet, so the bot starts the setup chat. */
export function newGroupSeed(): DemoData {
  return { shops: [], rules: [], synonyms: [], members: ["Amma", "Appa", "Ravi", "Priya"], items: [], tasks: [], lists: {}, onboarding: null };
}
