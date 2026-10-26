-- Producer: matters → decks (presentations) → regions, and presentation runs → run events.
--
-- Everything lives in its own `producer` schema. It is NOT exposed through the Supabase Data API: only the Producer
-- server reads and writes it, over a direct Postgres connection (DATABASE_URL). RLS is enabled with no policies and
-- the API roles get no grants, so the anon/authenticated keys can't touch it.
--
-- PDFs and thumbnails live in the private Storage bucket `producer-decks` at <deck id>/deck.pdf and <deck id>/thumb.jpg.

create schema if not exists producer;
comment on schema producer is 'Producer presentation tool: matters, decks, regions, runs.';

/* ---------- helpers ---------- */

create or replace function producer.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

/* ---------- matters ---------- */

create table producer.matters (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table producer.matters is 'A project. Groups presentations and their run history.';
create index matters_updated_at_idx on producer.matters (updated_at desc);
create trigger matters_set_updated_at before update on producer.matters
  for each row execute function producer.set_updated_at();

/* ---------- decks ---------- */

create table producer.decks (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references producer.matters (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  pdf_hash text not null check (pdf_hash ~ '^[0-9a-f]{64}$'),
  slide_count integer not null check (slide_count > 0),
  -- analysis finished (or was skipped); opening the deck goes straight to review
  analyzed boolean not null default false,
  pdf_path text not null,
  thumb_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table producer.decks is 'A PDF presentation in a matter. The file itself is in Storage at pdf_path.';
create index decks_matter_id_idx on producer.decks (matter_id, updated_at desc);
create trigger decks_set_updated_at before update on producer.decks
  for each row execute function producer.set_updated_at();

/* ---------- regions ---------- */

create table producer.regions (
  deck_id uuid not null references producer.decks (id) on delete cascade,
  slide_index integer not null check (slide_index >= 0),
  -- display order within the slide
  position integer not null check (position >= 0),
  -- slug, unique within a slide; the app's Region.id
  region_key text not null check (region_key ~ '^[a-z0-9-]{1,64}$'),
  label text not null check (char_length(label) between 1 and 200),
  description text not null default '',
  keywords text[] not null default '{}',
  -- box as fractions of the slide, origin top-left
  box_x double precision not null check (box_x between 0 and 1),
  box_y double precision not null check (box_y between 0 and 1),
  box_w double precision not null check (box_w > 0 and box_x + box_w <= 1.000001),
  box_h double precision not null check (box_h > 0 and box_y + box_h <= 1.000001),
  primary key (deck_id, slide_index, region_key),
  unique (deck_id, slide_index, position)
);
comment on table producer.regions is 'Zoomable areas on a slide, with the spoken keywords that trigger them.';

/* ---------- runs ---------- */

create table producer.runs (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references producer.decks (id) on delete cascade,
  -- snapshots, so a run still reads well after the deck is renamed or re-uploaded
  deck_name text not null,
  slide_count integer not null check (slide_count > 0),
  engine text,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  -- aggregates of run_events, stored for fast history lists
  slides_visited integer not null default 0 check (slides_visited >= 0),
  zooms integer not null default 0 check (zooms >= 0),
  commands integer not null default 0 check (commands >= 0),
  words integer not null default 0 check (words >= 0),
  created_at timestamptz not null default now(),
  check (ended_at >= started_at)
);
comment on table producer.runs is 'One time a deck was presented.';
create index runs_started_at_idx on producer.runs (started_at desc);
create index runs_deck_id_idx on producer.runs (deck_id, started_at desc);

create table producer.run_events (
  run_id uuid not null references producer.runs (id) on delete cascade,
  seq integer not null check (seq >= 0),
  -- ms since the run started
  t_ms integer not null check (t_ms >= 0),
  type text not null check (type in ('slide', 'zoom', 'command', 'heard')),
  slide_index integer not null check (slide_index >= 0),
  region_key text,
  label text,
  command text,
  text text,
  simulated boolean not null default false,
  primary key (run_id, seq),
  check (type <> 'zoom' or (region_key is not null and label is not null)),
  check (type <> 'command' or (command is not null and text is not null)),
  check (type <> 'heard' or text is not null)
);
comment on table producer.run_events is 'Timeline of a run: slide changes, zooms, voice commands and what was heard.';

/* ---------- keep matters.updated_at = last activity ---------- */

create or replace function producer.touch_matter_from_deck() returns trigger
language plpgsql set search_path = '' as $$
begin
  update producer.matters set updated_at = now()
  where id = case when tg_op = 'DELETE' then old.matter_id else new.matter_id end;
  return null;
end $$;
create trigger decks_touch_matter after insert or update or delete on producer.decks
  for each row execute function producer.touch_matter_from_deck();

create or replace function producer.touch_matter_from_run() returns trigger
language plpgsql set search_path = '' as $$
begin
  update producer.matters m set updated_at = greatest(m.updated_at, new.ended_at)
  from producer.decks d
  where d.id = new.deck_id and m.id = d.matter_id;
  return null;
end $$;
create trigger runs_touch_matter after insert on producer.runs
  for each row execute function producer.touch_matter_from_run();

/* ---------- read models ---------- */

create view producer.run_summaries with (security_invoker = true) as
select r.*, d.matter_id, m.name as matter_name
from producer.runs r
join producer.decks d on d.id = r.deck_id
join producer.matters m on m.id = d.matter_id;

create view producer.deck_summaries with (security_invoker = true) as
select
  d.*,
  coalesce(rg.region_count, 0)::integer as region_count,
  coalesce(ru.run_count, 0)::integer as run_count,
  ru.last_run_at
from producer.decks d
left join (select deck_id, count(*) as region_count from producer.regions group by deck_id) rg on rg.deck_id = d.id
left join (select deck_id, count(*) as run_count, max(started_at) as last_run_at from producer.runs group by deck_id) ru
  on ru.deck_id = d.id;

create view producer.matter_summaries with (security_invoker = true) as
select
  m.*,
  (select count(*) from producer.decks d where d.matter_id = m.id)::integer as deck_count,
  (select count(*) from producer.run_summaries r where r.matter_id = m.id)::integer as run_count,
  (select max(r.started_at) from producer.run_summaries r where r.matter_id = m.id) as last_run_at,
  (select d.id from producer.decks d
    where d.matter_id = m.id and d.thumb_path is not null
    order by d.updated_at desc limit 1) as thumb_deck_id
from producer.matters m;

/* ---------- lock it down: server-only ---------- */

alter table producer.matters enable row level security;
alter table producer.decks enable row level security;
alter table producer.regions enable row level security;
alter table producer.runs enable row level security;
alter table producer.run_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema producer from anon, authenticated;
    revoke all on all tables in schema producer from anon, authenticated;
    revoke all on all functions in schema producer from anon, authenticated, public;
  end if;
end $$;

/* ---------- storage bucket for PDFs + thumbnails (private) ---------- */

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('producer-decks', 'producer-decks', false, 209715200, array['application/pdf', 'image/jpeg'])
    on conflict (id) do nothing;
  end if;
end $$;
