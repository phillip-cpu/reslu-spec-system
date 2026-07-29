-- Project Overview: persistent, data-aware dismissal of register/pricing
-- quality prompts. Operational health remains computed in real time;
-- these rows only control the project overview presentation.

create table if not exists project_data_quality_dismissals (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  issue_code        text not null,
  issue_fingerprint text not null,
  dismissed_by      uuid references profiles(id) on delete set null,
  dismissed_at      timestamptz not null default now(),
  unique(project_id, issue_code)
);

create index if not exists idx_project_data_quality_dismissals_project
  on project_data_quality_dismissals(project_id);

comment on table project_data_quality_dismissals is
  'Project Overview UI dismissals for register/pricing data-quality issues. Aria, company health and operational automation continue to use the unfiltered report. The fingerprint represents the exact affected entity set, so changed or newly affected data resurfaces the issue automatically.';

comment on column project_data_quality_dismissals.issue_fingerprint is
  'Stable hash of issue code plus sorted affected entity ids. A row only hides the issue while this fingerprint still matches.';

alter table project_data_quality_dismissals enable row level security;

drop policy if exists "team_all" on project_data_quality_dismissals;
create policy "team_all" on project_data_quality_dismissals
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
