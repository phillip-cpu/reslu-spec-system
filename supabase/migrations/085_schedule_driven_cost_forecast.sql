-- Link each live estimate section to the construction phase that drives
-- its forecast timing. A phase can carry many estimate sections, while
-- each section has one authoritative timing source.
alter table cost_sections
  add column if not exists forecast_phase_id uuid
  references schedule_phases(id) on delete set null;

create index if not exists idx_cost_sections_forecast_phase
  on cost_sections(forecast_phase_id);

comment on column cost_sections.forecast_phase_id is
  'Timeline phase whose end_date drives the forecast date for every cost line in this estimate section.';
