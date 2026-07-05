-- ============================================================
-- RESLU Spec System — Phase 12a-B: My Work, Board v2, housekeeping
-- (projects.alias), client events.
-- BUILD-SPEC.md "Phase 12a — My Work + estimate versioning with VM"
-- (My Work half only — versioning/SOW/plan-analysis is migration
-- 019/Phase 12a-A's file), "Board v2", "Housekeeping — 5 July
-- screenshot" (item 2, projects.alias), "Portal — upcoming client
-- meetings".
--
-- Conventions carried over from every prior migration (013/019 most
-- recently):
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; none of this migration's data is
--     financial)
--   - soft delete via nullable deleted_at where the spec calls for it
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate triggers & policies) so a partial
--     apply converges cleanly on re-run
-- ============================================================

-- ============================================================
-- PART 1 — Board v2: multi-assignee (board_task_assignees)
-- BUILD-SPEC.md "Board v2" point 1: "Multi-assignee:
-- board_task_assignees join table (task_id, profile_id) replacing
-- single assignee_id (migrate existing values); cards show stacked
-- initials."
--
-- board_tasks.assignee_id is KEPT (not dropped) per this task's brief
-- ("keep column for now, comment deprecation") — existing code outside
-- this migration's boundary (e.g. any historical report) may still
-- read it, and dropping a column live team members are mid-edit on is
-- unnecessary risk for a schema-only migration. It is backfilled into
-- the new join table below and should be treated as deprecated/
-- read-only going forward — all NEW writes go through
-- board_task_assignees (see app/api/board-tasks/[id]/route.ts's PATCH
-- handler in this same task).
-- ============================================================
create table if not exists board_task_assignees (
  task_id     uuid not null references board_tasks(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (task_id, profile_id)
);

create index if not exists idx_board_task_assignees_profile on board_task_assignees(profile_id);

-- Backfill: every existing board_tasks row with a non-null assignee_id
-- gets a corresponding board_task_assignees row, so multi-assignee
-- reads (GET .../board) return the same assignee a client viewed
-- yesterday under the old single-column model, with zero visible
-- change on first load after this migration applies.
insert into board_task_assignees (task_id, profile_id)
select id, assignee_id
from board_tasks
where assignee_id is not null
on conflict (task_id, profile_id) do nothing;

comment on column board_tasks.assignee_id is
  'DEPRECATED (migration 020) — superseded by board_task_assignees (multi-assignee). Kept read-only for backward compatibility; do not write to this column in new code. See BUILD-SPEC.md "Board v2" point 1.';

-- ============================================================
-- PART 2 — Board v2: phase grouping (board_groups + board_tasks.phase_group_id)
-- BUILD-SPEC.md "Board v2" point 3 / "Housekeeping" cross-ref: "Monday-
-- like phase grouping ... board gains a second view toggle — Grouped
-- list ... Groups = construction phases, seeded per project from a
-- phase template (Site Prep, Demolition, Rough-in, Waterproofing &
-- Tiling, Fit-off, Handover — editable in Settings) ... board_tasks
-- gains phase_group_id (nullable, references board_groups: project_id,
-- name, sort)."
--
-- Seeded lazily on first visit to the Grouped list view (same
-- idempotent "seed if the project currently has zero groups" pattern
-- as board_columns in migration 013), not by this migration, for the
-- same reason board_columns isn't migration-seeded: a project nobody
-- has opened the Grouped list view for yet should carry no dead rows.
-- ============================================================
create table if not exists board_groups (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_board_groups_project on board_groups(project_id, sort);

drop trigger if exists trg_board_groups_updated_at on board_groups;
create trigger trg_board_groups_updated_at
  before update on board_groups
  for each row execute function set_updated_at();

alter table board_tasks
  add column if not exists phase_group_id uuid references board_groups(id) on delete set null;

create index if not exists idx_board_tasks_phase_group on board_tasks(phase_group_id);

-- ============================================================
-- PART 3 — Housekeeping: projects.alias
-- BUILD-SPEC.md "Housekeeping — 5 July screenshot" point 2: "projects
-- gains alias text (e.g. 'Nth Adelaide townhouse') — editable in
-- project settings; displayed as a muted suffix/subtitle on internal
-- surfaces (dashboard card, project header, My Work). NEVER
-- client-facing (portal/PDF keep formal name)."
-- ============================================================
alter table projects
  add column if not exists alias text;

comment on column projects.alias is
  'Internal-only short name/nickname (e.g. "Nth Adelaide townhouse"). Team surfaces only — NEVER read by the client portal or the builder/schedule PDF, which both keep using projects.name. See BUILD-SPEC.md "Housekeeping — 5 July screenshot" point 2.';

-- ============================================================
-- PART 4 — Client events (client_events)
-- BUILD-SPEC.md "Portal — upcoming client meetings": "client_events
-- (id, project_id, title e.g. 'Selections meeting — studio',
-- starts_at timestamptz, ends_at nullable, location text, notes,
-- created_by, deleted_at). Team manages from the project client area
-- ... Portal: 'Upcoming meetings' card ... Reminder email to client
-- the day before via notify-client."
--
-- Distinct from trade_visits (016_trade_visits.sql — internal-only,
-- never client-visible) and from leads' site_visit_date (pre-project,
-- lives on the leads table) — this is its own table per the spec's own
-- "Distinct from trade_visits ... and from lead site visits" framing.
-- ============================================================
create table if not exists client_events (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  title       text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  location    text,
  -- Client-facing by design (this table's whole purpose is the portal
  -- "Upcoming meetings" card) — keep entries client-appropriate; see
  -- lib/client-event-reminders.ts and components/client-area/ClientEventsPanel.tsx
  -- doc comments for the same note repeated at the point of use.
  notes       text,
  -- Reminder gate — mirrors trade_visits.reminder_sent_at's exact
  -- "stamped once, never re-sent" pattern (migration 016). Nullable;
  -- set by POST /api/client-events/remind once a reminder email sends
  -- successfully for this event.
  reminder_sent_at timestamptz,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint chk_client_events_dates check (ends_at is null or ends_at >= starts_at)
);

create index if not exists idx_client_events_project on client_events(project_id, starts_at);
create index if not exists idx_client_events_deleted_at on client_events(deleted_at);
-- Supports the reminder route's "starting tomorrow, not yet reminded" query.
create index if not exists idx_client_events_reminder on client_events(starts_at, reminder_sent_at) where deleted_at is null;

drop trigger if exists trg_client_events_updated_at on client_events;
create trigger trg_client_events_updated_at
  before update on client_events
  for each row execute function set_updated_at();

-- ============================================================
-- PART 5 — My Work: user_notes
-- BUILD-SPEC.md "Phase 12a — My Work": "Personal notes section
-- (user_notes table: user_id, text, done, created_at)." Detailed scope
-- in this task's brief adds sort + updated_at for inline reordering/
-- editing parity with every other editable list in this codebase.
-- ============================================================
create table if not exists user_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  text        text not null,
  done        boolean not null default false,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_user_notes_user on user_notes(user_id, done, sort);

drop trigger if exists trg_user_notes_updated_at on user_notes;
create trigger trg_user_notes_updated_at
  before update on user_notes
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — same Phase 1 permissive "team_all" shape as
-- every other non-financial table in this codebase. user_notes is the
-- one exception worth calling out: notes are PERSONAL (per-user), but
-- per BUILD-SPEC.md §Security ("Phase 1 all team members equal;
-- admin-only settings enforced in API, no unenforced role theatre")
-- this codebase has never used per-row RLS scoping anywhere else
-- (e.g. board_tasks.assignee_id carries no RLS restricting who can see
-- another user's assigned cards either) — real enforcement of "only
-- I see/edit my own notes" is the API layer's user_id = session user
-- check (app/api/my-work/notes/**), consistent with how every other
-- "who can touch this row" rule in the app is enforced above RLS, not
-- inside it. A stricter per-user RLS policy here would be the only
-- such exception in the whole schema and isn't needed for a small
-- internal team tool.
-- ============================================================
alter table board_task_assignees enable row level security;
alter table board_groups enable row level security;
alter table client_events enable row level security;
alter table user_notes enable row level security;

drop policy if exists "team_all" on board_task_assignees;
create policy "team_all" on board_task_assignees
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on board_groups;
create policy "team_all" on board_groups
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on client_events;
create policy "team_all" on client_events
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on user_notes;
create policy "team_all" on user_notes
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
