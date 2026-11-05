export type Family = {
  id: string;
  name: string;
  whatsapp_group_name: string;
};

export type Member = {
  id: string;
  family_id: string;
  display_name: string;
};

export type Shop = {
  id: string;
  family_id: string;
  name: string;
  categories: string[];
  example_items: string[];
  priority: number;
  notes: string | null;
};

export type ItemStatus = "needed" | "bought" | "removed";

export type Item = {
  id: string;
  family_id: string;
  name: string;
  item_key: string;
  quantity: string | null;
  notes: string | null;
  shop_id: string | null;
  status: ItemStatus;
  requested_by: string[];
  source: "whatsapp" | "web";
  created_at: string;
  bought_at: string | null;
  // AI suggestion while the item is in "Needs review" (shop_id is null)
  proposed_shop_id: string | null;
  proposal_confidence: number | null;
  proposal_reason: string | null;
  proposed_at: string | null;
};

export type Rule = {
  id: string;
  item_key: string;
  shop_id: string;
};

export type SyncState = {
  last_synced_at: string | null;
};

export type Synonym = {
  id: string;
  family_id: string;
  word_a: string;
  word_b: string;
};
