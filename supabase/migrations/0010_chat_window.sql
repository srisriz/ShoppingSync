-- The context window: the last few messages that weren't a clear action (a question,
-- "No", half a sentence), so the AI can read them as one conversation. The bot deletes
-- it once it has acted, and the listener deletes any window left quiet for 5 minutes.
alter table public.families add column if not exists chat_window jsonb;

notify pgrst, 'reload schema';
