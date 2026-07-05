-- ============================================================
-- RESLU Spec System — Phase 13: Office board
-- BUILD-SPEC.md §"Phase 12b + 13 — specced from Aria's briefs (received
-- 5 July 2026)" / "13 Office" (from docs/OFFICE-BRIEF.md, Aria's Monday
-- board export dated 5 Jul 2026): "global Office board (not per-
-- project): department groups — Marketing, Website, Meta Ads, Google
-- Ads, Operations, Systems & Tech, Phillip (personal queue), Archived.
-- Needs: subtasks on tasks (Monday subitems equivalent), standing rule
-- cards (pinned, non-completable notes e.g. 'DO NOT enable Google AI
-- Max'), archive group behaviour (completed items move there, kept for
-- reference). Feeds My Work. Aria creates items via API for actionable
-- inbound work (her stated 24-48h resolution pattern)."
--
-- Deliberately its own table family (office_groups / office_tasks /
-- office_task_assignees / office_subtasks), NOT a reuse of
-- board_groups/board_tasks — those are per-project
-- (project_id not null, migration 013/020) and this board is global
-- (no project at all, per OFFICE-BRIEF.md's "It is not a project
-- board"). Bolting a nullable project_id onto board_tasks to represent
-- "no project" would silently change the meaning of every existing
-- per-project board query (e.g. "all board_tasks for project X" could
-- no longer assume project_id is never null) for a feature that has
-- its own department vocabulary (Marketing/Meta Ads/Google Ads) with no
-- overlap with construction phase groups (Site Prep/Demolition/etc.).
-- A parallel, purpose-built table family costs one migration and keeps
-- both boards' invariants simple.
--
-- Conventions carried over from every prior migration (020 most
-- recently):
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; none of this migration's data is
--     financial). Phillip's personal group is a department group like
--     any other, visible to the whole team on this shared board — no
--     special RLS gating, per OFFICE-BRIEF.md ("Phillip" is his queue
--     ON the shared board, not a private one).
--   - soft delete via nullable deleted_at
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate triggers & policies) so a partial
--     apply converges cleanly on re-run
-- ============================================================

-- ============================================================
-- PART 1 — office_groups (departments)
-- Seeded in the exact order OFFICE-BRIEF.md's board export lists the
-- departments the team actually uses today, with Archived placed last
-- (BUILD-SPEC.md's task brief lists Archived before Phillip, matching
-- OFFICE-BRIEF.md's own "Position" column 1-8 table — Archived is
-- position 7, Phillip is position 8, on the real Monday board; this
-- migration mirrors that exact order rather than the prose-list order
-- the task brief's summary sentence happens to use, since the brief's
-- own reference table is the more authoritative source for "in that
-- order").
-- ============================================================
create table if not exists office_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_office_groups_sort on office_groups(sort);
create index if not exists idx_office_groups_deleted_at on office_groups(deleted_at);

drop trigger if exists trg_office_groups_updated_at on office_groups;
create trigger trg_office_groups_updated_at
  before update on office_groups
  for each row execute function set_updated_at();

-- Seed the eight standing departments, in board order, ONLY if the
-- table is currently empty — idempotent re-run safety (same "seed only
-- if zero rows" heuristic as board_columns/board_groups elsewhere in
-- this codebase), and it means a team member who has already renamed
-- one of these groups by the time this migration re-runs never has
-- their rename clobbered.
insert into office_groups (name, sort)
select v.name, v.sort
from (values
  ('Marketing', 0),
  ('Website', 1000),
  ('Meta Ads', 2000),
  ('Google Ads', 3000),
  ('Operations', 4000),
  ('Systems & Tech', 5000),
  ('Phillip', 6000),
  ('Archived', 7000)
) as v(name, sort)
where not exists (select 1 from office_groups);

-- ============================================================
-- PART 2 — office_tasks
-- kind 'task' (normal, completable, participates in My Work) vs 'rule'
-- (standing reminder card — OFFICE-BRIEF.md's "DO NOT enable Google AI
-- Max when prompted" — pinned at the top of its group, no due date, no
-- checkbox, never completable; see app layer, not a DB constraint,
-- for "un-completable" since the simplest correct enforcement is the
-- API route refusing a complete/uncomplete action on a 'rule' row
-- rather than a CHECK constraint fighting the same completed_at column
-- every 'task' row uses normally).
--
-- Archive-on-complete (BUILD-SPEC.md "archive group behaviour ...
-- completed items move there, kept for reference"): completing a task
-- sets completed_at AND moves group_id to the Archived group. The
-- ORIGINAL group is remembered on prev_group_id (a dedicated nullable
-- FK column, not smuggled into `description` text) so "uncomplete"
-- can restore the task to where it came from — a real column is
-- queryable/indexable and survives a description edit made while the
-- task sits in Archived, unlike a text-encoded marker.
-- ============================================================
create table if not exists office_tasks (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references office_groups(id) on delete cascade,
  title           text not null,
  description     text,
  kind            text not null default 'task' check (kind in ('task', 'rule')),
  due_date        date,
  sort            integer not null default 0,
  -- Archive-on-complete memory — the group this task lived in
  -- immediately before a complete action moved it to Archived. Null
  -- for any task that has never been completed. Set back to null once
  -- an uncomplete action restores the task (see app/api/office/tasks/[id]
  -- route's PATCH handler doc comment for the exact transition).
  prev_group_id   uuid references office_groups(id) on delete set null,
  created_by      uuid references profiles(id) on delete set null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists idx_office_tasks_group on office_tasks(group_id, sort);
create index if not exists idx_office_tasks_deleted_at on office_tasks(deleted_at);
create index if not exists idx_office_tasks_due_date on office_tasks(due_date) where deleted_at is null and completed_at is null;
create index if not exists idx_office_tasks_kind on office_tasks(kind);

drop trigger if exists trg_office_tasks_updated_at on office_tasks;
create trigger trg_office_tasks_updated_at
  before update on office_tasks
  for each row execute function set_updated_at();

comment on column office_tasks.kind is
  'task = normal completable card; rule = standing reminder/caution card (OFFICE-BRIEF.md "DO NOT enable Google AI Max"), pinned at the top of its group, never completable, no due date, no checkbox. Enforced in the API layer (app/api/office/tasks/[id] refuses complete/uncomplete on kind=rule), not by a CHECK constraint here.';
comment on column office_tasks.prev_group_id is
  'Archive-on-complete memory (migration 021): the group this task lived in immediately before a complete action moved it to the Archived group. Null until first completed; cleared back to null on uncomplete (which also restores group_id from here). See app/api/office/tasks/[id] PATCH handler.';

-- ============================================================
-- PART 3 — office_task_assignees (multi-assignee, mirrors
-- board_task_assignees exactly — migration 020's PART 1 comment
-- explains the join-table-over-single-column reasoning; not repeated
-- here since it's identical).
-- ============================================================
create table if not exists office_task_assignees (
  task_id     uuid not null references office_tasks(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (task_id, profile_id)
);

create index if not exists idx_office_task_assignees_profile on office_task_assignees(profile_id);

-- ============================================================
-- PART 4 — office_subtasks (Monday "subitems" equivalent)
-- BUILD-SPEC.md: "subtasks on tasks (Monday subitems equivalent —
-- board_task_subtasks or parent_task_id)". Modelled as its own table
-- (not a self-referencing parent_task_id on office_tasks) since
-- subtasks here are simple tick-list steps (title + done), not full
-- cards in their own right (no assignees/due date/kind of their own,
-- unlike a Monday subitem which is actually a full item) — matching
-- how BUILD-SPEC's own task brief phrases the progress chip ("'2/5'
-- chip") as a simple done-count, not a nested board.
-- ============================================================
create table if not exists office_subtasks (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references office_tasks(id) on delete cascade,
  title       text not null,
  done        boolean not null default false,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_office_subtasks_task on office_subtasks(task_id, sort);

drop trigger if exists trg_office_subtasks_updated_at on office_subtasks;
create trigger trg_office_subtasks_updated_at
  before update on office_subtasks
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — same Phase 1 permissive "team_all" shape as
-- every other non-financial table in this codebase (see migration
-- 020's own RLS section comment for the standing rationale; not
-- repeated in full here).
-- ============================================================
alter table office_groups enable row level security;
alter table office_tasks enable row level security;
alter table office_task_assignees enable row level security;
alter table office_subtasks enable row level security;

drop policy if exists "team_all" on office_groups;
create policy "team_all" on office_groups
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on office_tasks;
create policy "team_all" on office_tasks
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on office_task_assignees;
create policy "team_all" on office_task_assignees
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on office_subtasks;
create policy "team_all" on office_subtasks
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
