-- ShoppingSync: many WhatsApp groups, each with its own list and console
-- Run once in Supabase > SQL Editor > New query > paste > Run.
--
-- Each WhatsApp group is a "family" row. When the bot is added to a group it
-- creates a pending family and asks for the magic word (a one-time activation
-- code made in the owner console). A correct code activates the group; the
-- person who typed it gets a private one-time setup link to create that
-- group's console login. A wrong code, or no code within 24 hours, and the bot
-- leaves the group.

-- Families become groups ------------------------------------------------------
alter table public.families
  alter column owner_id drop not null,                         -- pending groups have no console login yet
  add column if not exists status text not null default 'active'
    check (status in ('pending', 'active', 'inactive', 'left')),
  add column if not exists prompt_message_id text,             -- the bot's "magic word" message
  add column if not exists prompt_sent_at   timestamptz,
  add column if not exists activated_at     timestamptz,
  add column if not exists activated_by     text;              -- WhatsApp id of whoever typed the code

create unique index if not exists families_group_jid_key
  on public.families (whatsapp_group_jid) where whatsapp_group_jid is not null;

-- The owner (you) ---------------------------------------------------------------
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.app_admins enable row level security;
drop policy if exists "admins: read self" on public.app_admins;
create policy "admins: read self" on public.app_admins for select using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid())
$$;
grant execute on function public.is_admin() to authenticated;

-- The existing family's login becomes the owner.
insert into public.app_admins (user_id)
select owner_id from public.families where owner_id is not null
on conflict do nothing;

drop policy if exists "admins: read all groups" on public.families;
create policy "admins: read all groups" on public.families for select using (public.is_admin());

-- One-time activation codes (the "magic word") ---------------------------------
create table if not exists public.activation_codes (
  id              uuid primary key default gen_random_uuid(),
  code_hash       text not null unique,                       -- SHA-256 of the code; the code itself is never stored
  label           text,                                       -- e.g. "Cousins group"
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  used_at         timestamptz,
  used_by_family  uuid references public.families(id) on delete set null
);
alter table public.activation_codes enable row level security;
drop policy if exists "admins only" on public.activation_codes;
create policy "admins only" on public.activation_codes
  for all using (public.is_admin()) with check (public.is_admin());

-- One-time setup links for each group's console login --------------------------
create table if not exists public.setup_tokens (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  token_hash  text not null unique,                          -- SHA-256 of the token in the link
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
alter table public.setup_tokens enable row level security;
drop policy if exists "admins only" on public.setup_tokens;
create policy "admins only" on public.setup_tokens
  for all using (public.is_admin()) with check (public.is_admin());

-- The setup page calls this after creating the new login: it links the login
-- to the group, once, if the link is valid and unused.
create or replace function public.claim_setup_token(p_token_hash text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  t record;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;
  select * into t from public.setup_tokens
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   for update;
  if not found then
    raise exception 'This setup link is invalid, used or expired. Ask the owner for a new one.';
  end if;
  if exists (select 1 from public.families where owner_id = auth.uid()) then
    raise exception 'This login already manages a group. Choose a different username.';
  end if;
  update public.families set owner_id = auth.uid()
   where id = t.family_id and owner_id is null and status = 'active';
  if not found then
    raise exception 'This group already has a console login, or is not active.';
  end if;
  update public.setup_tokens set used_at = now() where id = t.id;
  return t.family_id;
end;
$$;
grant execute on function public.claim_setup_token(text) to authenticated;
