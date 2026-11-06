-- Who ticked an item off, so "got milk" after someone else bought it can say
-- "Mom already ticked off milk at 14:20" instead of "milk wasn't on the list".
alter table public.items add column if not exists bought_by text;
