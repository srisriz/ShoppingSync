-- ShoppingSync: AI shop suggestions for items in "Needs review"
-- Run once in Supabase > SQL Editor > New query > paste > Run.
--
-- An item is "in review" while shop_id is null. The local AI worker fills in
-- a proposal; the family confirms it (or picks another shop) on the web page,
-- which sets shop_id and saves a rule so the item is matched automatically next time.

alter table public.items
  add column if not exists proposed_shop_id    uuid references public.shops(id) on delete set null,
  add column if not exists proposal_confidence real,
  add column if not exists proposal_reason     text,
  add column if not exists proposed_at         timestamptz;  -- null = not looked at by the AI yet

create index if not exists items_review_idx
  on public.items (family_id, created_at)
  where status = 'needed' and shop_id is null;
