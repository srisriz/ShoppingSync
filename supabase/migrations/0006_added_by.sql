-- Who brought the bot into each WhatsApp group, so the super user knows who to
-- send the magic word to. Numbers are stored as digits with country code ("447700900123").
alter table public.families
  add column if not exists added_by_number   text,   -- who added the bot to the group
  add column if not exists added_by_name     text,   -- their WhatsApp profile name, once known
  add column if not exists created_by_number text,   -- who created the WhatsApp group
  add column if not exists created_by_name   text,
  add column if not exists activated_by_name text;   -- who typed the magic word
