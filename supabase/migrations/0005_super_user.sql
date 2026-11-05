-- ShoppingSync: a fixed super user, group-only logins, group-specific magic words
-- Run once in Supabase > SQL Editor > New query > paste > Run.
--
-- Super user: one fixed login (created with `npm run superuser:create`), listed in
-- app_admins. It automatically has full control of every group: no per-group grant.
-- Group logins: each manages only its own group (unchanged).
-- Magic words: each code now belongs to one group and only works there.

-- Super user: full control of every group's data ----------------------------------
drop policy if exists "super user: all groups" on public.families;
create policy "super user: all groups" on public.families
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "super user" on public.members;
create policy "super user" on public.members  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "super user" on public.shops;
create policy "super user" on public.shops    for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "super user" on public.rules;
create policy "super user" on public.rules    for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "super user" on public.items;
create policy "super user" on public.items    for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "super user" on public.synonyms;
create policy "super user" on public.synonyms for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "super user" on public.questions;
create policy "super user" on public.questions  for select using (public.is_admin());
drop policy if exists "super user" on public.sync_state;
create policy "super user" on public.sync_state for select using (public.is_admin());

-- The read-all policy from 0004 is covered by the one above.
drop policy if exists "admins: read all groups" on public.families;

-- The group's console username, shown to the super user ------------------------------
alter table public.families add column if not exists console_username text;
update public.families f
   set console_username = split_part(u.email, '@', 1)
  from auth.users u
 where u.id = f.owner_id and f.console_username is null;

-- Magic words belong to one group -------------------------------------------------------
alter table public.activation_codes
  add column if not exists family_id uuid references public.families(id) on delete cascade;
-- Codes made before this change were not tied to a group: retire any unused ones.
delete from public.activation_codes where family_id is null and used_at is null;

-- Setup links also record the chosen username -----------------------------------------
drop function if exists public.claim_setup_token(text);
create or replace function public.claim_setup_token(p_token_hash text, p_username text)
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
    raise exception 'This setup link is invalid, used or expired. Ask the super user for a new one.';
  end if;
  if exists (select 1 from public.families where owner_id = auth.uid()) then
    raise exception 'This login already manages a group. Choose a different username.';
  end if;
  update public.families set owner_id = auth.uid(), console_username = lower(trim(p_username))
   where id = t.family_id and owner_id is null and status = 'active';
  if not found then
    raise exception 'This group already has a console login, or is not active.';
  end if;
  update public.setup_tokens set used_at = now() where id = t.id;
  return t.family_id;
end;
$$;
grant execute on function public.claim_setup_token(text, text) to authenticated;
