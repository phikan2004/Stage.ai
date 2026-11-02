-- Stage: a show is a demo the operator has been taught. Beats, limits and dry-run results are stored as documents, since
-- they're only ever read and written whole. Recordings and reference screenshots stay on the presenter's Mac.

create table producer.shows (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references producer.matters (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  beats jsonb not null default '[]',
  limits jsonb not null default '{"apps": [], "origins": [], "commands": []}',
  recording_id text,
  dry_runs jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table producer.shows is 'A demo taught to the Stage operator.';
create index shows_matter_id_idx on producer.shows (matter_id, updated_at desc);
create trigger shows_set_updated_at before update on producer.shows
  for each row execute function producer.set_updated_at();

alter table producer.shows enable row level security;

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on producer.shows from anon, authenticated;
  end if;
end $$;
