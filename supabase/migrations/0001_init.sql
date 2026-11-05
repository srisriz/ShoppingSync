-- ShoppingSync: initial schema
-- Run once in Supabase > SQL Editor > New query > paste > Run.
--
-- Access model
--   * One family login (a Supabase Auth user) owns one family row.
--   * The web page uses the publishable key; row-level security limits it
--     to that family's rows.
--   * The sync job and the local AI worker use the secret key, which
--     bypasses row-level security. Tables only they use have no policies.

create extension if not exists pgcrypto;

-- Families ------------------------------------------------------------------
create table public.families (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null unique references auth.users(id) on delete cascade,
  name                 text not null,
  whatsapp_group_name  text not null,
  whatsapp_group_jid   text,                     -- filled in by the sync job
  created_at           timestamptz not null default now()
);

-- The current login's family; used by every policy below.
create or replace function public.my_family_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select id from public.families where owner_id = auth.uid()
$$;

-- Members -------------------------------------------------------------------
create table public.members (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  display_name  text not null,
  whatsapp_id   text,                            -- filled in by the sync job
  created_at    timestamptz not null default now(),
  unique (family_id, display_name)
);

-- Shops ---------------------------------------------------------------------
create table public.shops (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  name           text not null,
  categories     text[] not null default '{}',
  example_items  text[] not null default '{}',
  priority       int  not null default 100,     -- lower number wins
  notes          text,
  created_at     timestamptz not null default now(),
  unique (family_id, name)
);

-- Rules: item -> shop, learned over time ------------------------------------
create table public.rules (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  item_name   text not null,
  item_key    text generated always as (lower(btrim(item_name))) stored,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  origin      text not null check (origin in ('setup', 'answer', 'correction')),
  created_at  timestamptz not null default now(),
  unique (family_id, item_key)
);

-- Items ---------------------------------------------------------------------
create table public.items (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  name               text not null,
  item_key           text generated always as (lower(btrim(name))) stored,
  quantity           text,
  notes              text,
  shop_id            uuid references public.shops(id) on delete set null,  -- null = unassigned
  status             text not null default 'needed'
                     check (status in ('needed', 'bought', 'removed')),
  requested_by       text[] not null default '{}',
  source             text not null check (source in ('whatsapp', 'web')),
  source_message_id  text,
  created_at         timestamptz not null default now(),
  bought_at          timestamptz
);
create index items_family_status_idx on public.items (family_id, status);
create index items_family_key_idx    on public.items (family_id, item_key);

-- Questions the bot has asked in the group ----------------------------------
create table public.questions (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  item_id     uuid not null references public.items(id) on delete cascade,
  message_id  text,
  options     text[] not null default '{}',
  status      text not null default 'open' check (status in ('open', 'answered', 'dropped')),
  created_at  timestamptz not null default now()
);

-- Sync state (readable by the family) ----------------------------------------
create table public.sync_state (
  family_id        uuid primary key references public.families(id) on delete cascade,
  last_synced_at   timestamptz,
  message_cursor   text,
  lock_expires_at  timestamptz
);

-- WhatsApp login session (server only; never readable from the web page) -----
create table public.wa_sessions (
  family_id   uuid primary key references public.families(id) on delete cascade,
  encrypted   text not null,                    -- encrypted by the app before saving
  updated_at  timestamptz not null default now()
);

-- Work queued for the local AI worker (server only) -------------------------
create table public.ai_tasks (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  message_id  text,
  kind        text not null check (kind in ('extract', 'map', 'question')),
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  input       jsonb not null,
  result      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index ai_tasks_status_idx on public.ai_tasks (status, created_at);

-- Every new family gets a sync_state row -------------------------------------
create or replace function public.create_sync_state()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.sync_state (family_id) values (new.id);
  return new;
end;
$$;

create trigger families_create_sync_state
after insert on public.families
for each row execute function public.create_sync_state();

-- Row-level security ----------------------------------------------------------
alter table public.families    enable row level security;
alter table public.members     enable row level security;
alter table public.shops       enable row level security;
alter table public.rules       enable row level security;
alter table public.items       enable row level security;
alter table public.questions   enable row level security;
alter table public.sync_state  enable row level security;
alter table public.wa_sessions enable row level security;   -- no policies: server only
alter table public.ai_tasks    enable row level security;   -- no policies: server only

create policy "own family: read"   on public.families for select using (owner_id = auth.uid());
create policy "own family: create" on public.families for insert with check (owner_id = auth.uid());
create policy "own family: edit"   on public.families for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "own family" on public.members   for all using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());
create policy "own family" on public.shops     for all using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());
create policy "own family" on public.rules     for all using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());
create policy "own family" on public.items     for all using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());
create policy "own family: read" on public.questions  for select using (family_id = public.my_family_id());
create policy "own family: read" on public.sync_state for select using (family_id = public.my_family_id());

-- Live updates on the web page when items change -------------------------------
alter publication supabase_realtime add table public.items;
