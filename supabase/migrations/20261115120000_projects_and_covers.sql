-- Matters are shown as projects, and demos get a cover.
-- A solo matter holds one deck or demo on its own and isn't shown as a project.

alter table producer.matters
  add column if not exists solo boolean not null default false;

comment on column producer.matters.solo is 'true: holds one deck or demo on its own, not shown as a project.';

-- The view's columns were fixed when it was created, so the new column is added by name, after the existing ones.
create or replace view producer.matter_summaries with (security_invoker = true) as
select
  m.id,
  m.name,
  m.created_at,
  m.updated_at,
  (select count(*) from producer.decks d where d.matter_id = m.id)::integer as deck_count,
  (select count(*) from producer.run_summaries r where r.matter_id = m.id)::integer as run_count,
  (select max(r.started_at) from producer.run_summaries r where r.matter_id = m.id) as last_run_at,
  (select d.id from producer.decks d
    where d.matter_id = m.id and d.thumb_path is not null
    order by d.updated_at desc limit 1) as thumb_deck_id,
  m.deck_mode,
  m.solo
from producer.matters m;

-- The recording frame a demo shows as its cover. The image itself stays on the presenter's Mac.
alter table producer.shows
  add column if not exists cover text;
