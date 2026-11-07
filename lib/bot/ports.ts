/**
 * What the bot's message handling needs from the outside world. The WhatsApp
 * listener plugs in Supabase, Baileys and Ollama; the demo page plugs in memory,
 * the on-screen phone and a small stand-in for the AI. The handling itself
 * (lib/bot/core.ts) is the same code in both.
 */
import type { ParsedAction } from "../parse";
import type { SynonymPair, MatchRule } from "../matching";
import type { AiShop, ExtractedActions, PastChoice, Proposal } from "../ai";
import type { SummaryItem } from "../info";

export type BotShop = { id: string; name: string; example_items: string[]; categories: string[]; priority: number; notes: string | null };
export type BotRule = MatchRule & { item_name: string };
export type BotItem = {
  id: string; name: string; item_key: string; quantity: string | null; shop_id: string | null;
  requested_by: string[]; status: "needed" | "bought" | "removed"; created_at: string; bought_at: string | null;
};
export type NewItem = { name: string; quantity: string | null; shop_id: string | null; requested_by: string[]; source_message_id: string };

export type Preference = { item: string; shop: string };
export type SynonymPairInput = { a: string; b: string };

/** A message from the group, in the form the handling needs. `ref` is whatever the chat needs to quote or react. */
export type IncomingMessage = {
  id: string;
  text: string;
  sender: string;
  /** Id of the message this one replies to, if any. */
  quotedId: string | null;
  /** Who wrote the message being replied to. */
  quotedFrom: "bot" | "other" | null;
  /** Who is @mentioned. */
  mentionsBot: boolean;
  mentionsOthers: boolean;
  ref: unknown;
};

/** A question the bot asked ("Shall I add rice? Reply yes"), waiting for an answer. */
export type QuestionInput = { actions: ParsedAction[]; preferences: Preference[]; synonyms: SynonymPairInput[]; sender: string; key: unknown };
/**
 * The setup chat a new group goes through in WhatsApp (see onboarding.ts).
 * step: which question is open; shopIds/index: the shops being asked about in turn;
 * guess: the AI's starting guess for the current shop, used if they reply "yes".
 */
export type Onboarding = {
  step: "shops" | "items" | "words" | "done";
  shopIds: string[];
  index: number;
  guess: { examples: string[]; categories: string[] } | null;
  askedAt: string;
  /** Already re-asked once after an answer that wasn't shops (e.g. "milk"): don't nag again. */
  nudged?: boolean;
};

/** A message saved while the AI was off. */
export type ParkedInput = { text: string; sender: string; key: unknown };

export interface BotStore {
  shops(): Promise<BotShop[]>;                         // priority order, then name
  rules(): Promise<BotRule[]>;                          // newest first
  synonymPairs(): Promise<SynonymPair[]>;
  members(): Promise<string[]>;
  neededItems(): Promise<BotItem[]>;                    // oldest first
  summaryItems(sinceIso: string): Promise<SummaryItem[]>;

  addItem(item: NewItem): Promise<BotItem | null>;
  updateItem(id: string, patch: Partial<Pick<BotItem, "name" | "quantity" | "requested_by" | "shop_id">>): Promise<void>;
  /** Marks still-needed items bought/removed; returns the ids that changed. With a shop, only that shop's items. */
  setStatus(ids: string[] | "all", status: "bought" | "removed", opts?: { shopId?: string; by?: string }): Promise<string[]>;
  /** Items ticked off since then, newest first, with who ticked them off (if known). */
  recentlyBought(sinceIso: string): Promise<{ name: string; item_key: string; bought_at: string; bought_by: string | null }[]>;
  deleteItems(ids: string[]): Promise<void>;
  moveNeededByKey(itemKey: string, shopId: string): Promise<void>;

  addShop(shop: { name: string; example_items: string[]; priority: number }): Promise<BotShop | null>;
  updateShop(id: string, patch: Partial<Pick<BotShop, "example_items" | "categories">>): Promise<void>;
  /** The group's setup chat, or null if it never started. */
  getOnboarding(): Promise<Onboarding | null>;
  setOnboarding(o: Onboarding): Promise<void>;
  upsertRules(rules: { item_name: string; shop_id: string; origin: "setup" | "answer" }[]): Promise<void>;
  addSynonym(a: string, b: string): Promise<boolean>;
  /** The AI should look again at these Needs review items (or all unproposed ones). */
  clearProposals(ids: string[] | "unproposed"): Promise<void>;

  addQuestion(messageId: string, input: QuestionInput): Promise<void>;
  /** Open questions: the one quoted (within a day), or any asked recently. */
  openQuestions(quotedId: string | null, windowMs: number): Promise<{ id: string; input: QuestionInput }[]>;
  closeTask(id: string, result: unknown): Promise<void>;

  park(messageId: string, input: ParkedInput): Promise<void>;
  parkedMessages(limit: number): Promise<{ id: string; input: ParkedInput }[]>;
  setTaskQueued(id: string): Promise<void>;
  setTaskRunning(id: string): Promise<void>;

  rememberList(messageId: string, itemIds: string[]): Promise<void>;
  listItemIds(messageId: string): Promise<string[] | undefined>;

  itemsAwaitingProposal(limit: number): Promise<{ id: string; name: string }[]>;
  saveProposal(id: string, p: { shopId: string | null; confidence: number; reason: string }): Promise<void>;
}

export interface BotChat {
  /** Sends a message to the group (optionally quoting one); returns its id. */
  send(text: string, quote?: IncomingMessage | null): Promise<string | null>;
  react(msg: IncomingMessage | { ref: unknown }, emoji: string): Promise<void>;
}

export interface BotAi {
  toEnglish(text: string, keepWords: string[]): Promise<{ language: string; english: string; confidence: number }>;
  extractActions(text: string): Promise<ExtractedActions>;
  chatReply(text: string, sender: string, ctx: { members: string[]; toBot: boolean }): Promise<string>;
  proposeShop(item: string, shops: AiShop[], past: PastChoice[], sameThings: string[][]): Promise<Proposal>;
  /** Setup chat: the shops or items listed in a sentence. */
  readList(kind: "shops" | "items", text: string): Promise<string[]>;
  /** Setup chat: a reply to "which shops?", split into shops and any items mentioned instead. */
  readShopAnswer(text: string): Promise<{ shops: string[]; items: string[] }>;
  /** Setup chat: a starting guess of what a family buys at a shop. */
  guessShopItems(shop: string): Promise<{ examples: string[]; categories: string[]; confidence: number }>;
}

/** Shared, long-lived state (one per running bot, across groups). */
export type BotState = { aiReady: boolean; napNotified: boolean; aiBusy: boolean };

export type Bot = {
  store: BotStore;
  chat: BotChat;
  ai: BotAi;
  state: BotState;
  log: (line: string) => void;
  /** A human-like pause before replying. */
  pause: (minMs: number, maxMs: number) => Promise<void>;
  /** Runs AI shop suggestions after this message (queued in the listener, straight after in the demo). */
  afterChange: () => void;
  now: () => Date;
  /** Link to this group's Needs review section on the web page (null if there's no page to link to). */
  reviewUrl: string | null;
};
