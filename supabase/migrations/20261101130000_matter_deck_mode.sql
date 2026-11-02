-- A matter holds either one presentation or several. Existing matters keep working as several.

alter table producer.matters
  add column deck_mode text not null default 'multiple' check (deck_mode in ('single', 'multiple'));

comment on column producer.matters.deck_mode is 'single: one presentation; multiple: any number.';

-- The view's m.* was fixed when it was created, so the new column has to be added by name, after the existing ones.
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
  m.deck_mode
from producer.matters m;
