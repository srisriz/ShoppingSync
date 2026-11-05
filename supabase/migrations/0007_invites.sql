-- Personal invites: the super user invites someone by name and WhatsApp number.
-- Their link (/use-me?invite=…) shows the bot's number; when that number adds the bot
-- to a group, the group is switched on without a magic word. Only the link's hash is stored.
create table if not exists public.invites (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  number       text not null,                 -- digits with country code, e.g. 447700900123
  token_hash   text not null unique,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  opened_at    timestamptz,                   -- first time the link was opened
  cancelled_at timestamptz,
  used_at      timestamptz,                   -- the group it set up was switched on
  family_id    uuid references public.families(id) on delete set null
);
create index if not exists invites_number_idx on public.invites (number);

alter table public.invites enable row level security;
drop policy if exists "super user" on public.invites;
create policy "super user" on public.invites for all using (public.is_admin()) with check (public.is_admin());

-- Settings the bot shares with the website (e.g. its own phone number). No policies:
-- only the server (secret key) reads or writes it, so the number never reaches a browser
-- unless the server decides to show it.
create table if not exists public.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
