-- The setup chat a new WhatsApp group goes through (which question is open, which shops
-- it's asking about). Groups that already have shops count as set up, so they're never asked;
-- groups with no shops yet are offered the setup chat on their next message.
alter table public.families add column if not exists onboarding jsonb;
update public.families f
   set onboarding = jsonb_build_object('step', 'done', 'shopIds', '[]'::jsonb, 'index', 0, 'guess', null, 'askedAt', now())
 where f.onboarding is null
   and exists (select 1 from public.shops s where s.family_id = f.id);
