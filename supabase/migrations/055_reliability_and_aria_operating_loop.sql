-- ============================================================
-- RESLU Spec System - Phase 2 reliability + Aria operating loop.
--
-- 1. system_job_runs records that a scheduled job actually completed,
--    independently of whether it happened to have an email to send.
-- 2. brain_notes gives Aria a source-attributed, searchable place for
--    durable lessons and decisions (rather than relying only on local
--    prompt files that Spec cannot retrieve).
-- 3. daily_review / weekly_review queue kinds turn the existing wake
--    loop into a proactive operating cadence while keeping all external
--    and high-impact actions behind the existing human approval gates.
-- ============================================================

create table if not exists system_job_runs (
  id          uuid primary key default gen_random_uuid(),
  job_key     text not null,
  status      text not null check (status in ('succeeded','degraded','failed')),
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  summary     jsonb not null default '{}'::jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_system_job_runs_job_finished
  on system_job_runs(job_key, finished_at desc);
create index if not exists idx_system_job_runs_status_finished
  on system_job_runs(status, finished_at desc);

alter table system_job_runs enable row level security;
drop policy if exists "team_all" on system_job_runs;
drop policy if exists "team_read" on system_job_runs;
create policy "team_read" on system_job_runs
  for select to authenticated using (true);

comment on table system_job_runs is
  'Phase 2 reliability. One immutable completion record per monitored scheduled-job invocation. Health uses this execution evidence rather than inferring that a cron ran from an optional side effect such as an email_sends row.';

create table if not exists brain_notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  tags        text[] not null default '{}',
  source      text not null default 'aria',
  source_ref  text,
  confidence  numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_brain_notes_created_at on brain_notes(created_at desc);
create index if not exists idx_brain_notes_tags on brain_notes using gin(tags);

drop trigger if exists trg_brain_notes_updated_at on brain_notes;
create trigger trg_brain_notes_updated_at
  before update on brain_notes
  for each row execute function set_updated_at();

alter table brain_notes enable row level security;
drop policy if exists "team_all" on brain_notes;
create policy "team_all" on brain_notes
  for all to authenticated using (true) with check (true);

comment on table brain_notes is
  'Phase 2 Aria operating loop. Durable, source-attributed business learnings and decisions written through add_brain_note, indexed into workspace_index as entity_type=memory, and retrieved through Second Brain search. Not a replacement for immutable source records; source/source_ref/confidence preserve provenance.';

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review'
    ));

comment on column aria_queue.kind is
  'Operational/event kinds from migrations 033-051 plus daily_review and weekly_review (Phase 2). Routine items are inserted by /api/aria-queue/routines, claimed by Aria through get_aria_queue, and retained as the routine audit trail.';

notify pgrst, 'reload schema';
