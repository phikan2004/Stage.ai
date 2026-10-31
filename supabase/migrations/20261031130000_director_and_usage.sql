-- The director: a whole-deck plan, how each region is cued, and the phrases that trigger it.
-- Usage: every billed Claude call during analysis, with real token counts.
-- Additive only, so a server still running the previous code keeps working.

alter table producer.decks add column if not exists plan jsonb;

alter table producer.regions
  add column if not exists cue text check (cue in ('outline', 'zoom')),
  add column if not exists phrases text[] not null default '{}';
comment on column producer.regions.cue is 'How the region is emphasized. Null for regions from before the director, which zoom.';

alter table producer.run_events add column if not exists cue text check (cue in ('outline', 'zoom'));

create table if not exists producer.analysis_usage (
  id uuid primary key default gen_random_uuid(),
  -- kept after a deck is deleted: the money was still spent
  deck_id uuid references producer.decks (id) on delete set null,
  kind text not null check (kind in ('plan', 'slide', 'region')),
  slide_index integer check (slide_index >= 0),
  model text not null,
  effort text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  -- null when the model has no known price
  cost_usd numeric(12, 6),
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null default now()
);
comment on table producer.analysis_usage is 'One row per billed Claude call during analysis.';
create index if not exists analysis_usage_deck_id_idx on producer.analysis_usage (deck_id);
create index if not exists analysis_usage_created_at_idx on producer.analysis_usage (created_at desc);

alter table producer.analysis_usage enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on producer.analysis_usage from anon, authenticated;
  end if;
end $$;
