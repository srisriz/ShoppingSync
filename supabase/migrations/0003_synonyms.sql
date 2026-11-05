-- ShoppingSync: synonyms ("paal" = "milk", "thayir" = "curd")
-- Run once in Supabase > SQL Editor > New query > paste > Run.
--
-- Each row is a pair of words the family uses interchangeably. Pairs join into
-- groups (thayir = curd and curd = yoghurt makes all three the same thing).
-- The list keeps the word that was typed; synonyms are used for matching to
-- shops, merging duplicates, and "got"/"done".

create table if not exists public.synonyms (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  word_a      text not null,
  word_b      text not null,
  key_a       text generated always as (lower(btrim(word_a))) stored,
  key_b       text generated always as (lower(btrim(word_b))) stored,
  created_at  timestamptz not null default now(),
  unique (family_id, key_a, key_b),
  check (lower(btrim(word_a)) <> lower(btrim(word_b)))
);

alter table public.synonyms enable row level security;

drop policy if exists "own family" on public.synonyms;
create policy "own family" on public.synonyms
  for all using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());
