-- Robot rehearsals call Claude for a script and for each piece of feedback; their cost is recorded like analysis.
-- Rerunnable: the check is dropped and added again, so applying this by hand and again on merge both work.

alter table producer.analysis_usage drop constraint if exists analysis_usage_kind_check;
alter table producer.analysis_usage
  add constraint analysis_usage_kind_check check (kind in ('plan', 'slide', 'region', 'rehearse'));
