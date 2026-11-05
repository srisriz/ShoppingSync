/**
 * "Replace Riz with Rice": works out the changes, without touching the database,
 * so the rules can be tested on their own.
 *
 *  - only items still on the list (status "needed") are considered
 *  - matching ignores case and plurals ("riz", "Rizs"), nothing fuzzy
 *  - after renaming, items with the new name under the SAME shop merge into one
 *    (the oldest is kept; requesters and quantities are combined)
 *  - items under different shops are never merged ("Needs review" counts as its own place)
 */
import { itemVariants, normalise } from "./matching";

export type ReplaceItem = {
  id: string;
  name: string;
  shop_id: string | null;
  quantity: string | null;
  requested_by: string[];
  created_at: string;
  status: string;
};

export type ReplacePlan = {
  renamed: string[];                       // ids renamed to the new name
  updates: { id: string; name: string; quantity: string | null; requested_by: string[] }[];
  deletes: string[];                       // duplicates folded into a kept item
  mergedShops: { shop_id: string | null; count: number }[];
};

const same = (a: string, b: string) => itemVariants(normalise(a)).has(normalise(b)) || itemVariants(normalise(b)).has(normalise(a));

export function planReplace(items: ReplaceItem[], from: string, to: string): ReplacePlan {
  const open = items.filter((i) => i.status === "needed");
  const renamed = open.filter((i) => same(i.name, from)).map((i) => i.id);
  const plan: ReplacePlan = { renamed, updates: [], deletes: [], mergedShops: [] };
  if (renamed.length === 0) return plan;

  // Everything that will be called `to` afterwards: renamed items plus any already named `to`.
  const after = open
    .filter((i) => renamed.includes(i.id) || same(i.name, to))
    .map((i) => (renamed.includes(i.id) ? { ...i, name: to } : i));

  // Group by shop; merge within each group only.
  const byShop = new Map<string, typeof after>();
  for (const i of after) {
    const key = i.shop_id ?? "__review__";
    byShop.set(key, [...(byShop.get(key) ?? []), i]);
  }
  for (const group of byShop.values()) {
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const [keep, ...dupes] = group;
    const requested_by = [...new Set(group.flatMap((i) => i.requested_by))];
    const quantities = group.map((i) => i.quantity).filter((q): q is string => !!q);
    const quantity = quantities.length ? quantities.join(" + ") : null;
    const changedName = renamed.includes(keep.id);
    if (dupes.length || changedName) {
      plan.updates.push({ id: keep.id, name: to, quantity: dupes.length ? quantity : keep.quantity, requested_by: dupes.length ? requested_by : keep.requested_by });
    }
    if (dupes.length) {
      plan.deletes.push(...dupes.map((d) => d.id));
      plan.mergedShops.push({ shop_id: keep.shop_id, count: group.length });
    }
  }
  return plan;
}
