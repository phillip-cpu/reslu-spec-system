-- ============================================================
-- RESLU Spec System — Phase 12b: Design Framework pipeline
-- BUILD-SPEC.md §"Phase 12b + 13 — specced from Aria's briefs (received
-- 5 July 2026)" / "12b Design Framework" (from docs/DESIGN-FRAMEWORK-
-- BRIEF.md, Aria's Monday board export, Board ID 5027297754): "design
-- pipeline per project with the 7 real phases — Project Milestones,
-- Presentation, Concepts, 3D Working Model, WD Package, Renders,
-- Sampling & Furniture. Entirely manual on Monday today (no Aria
-- automations to preserve — clean build). Design tab on projects: phase
-- checklist/kanban with per-phase tasks, deadlines, assignees (multi,
-- auto-assign creator per Board v2), completion rolling into overview
-- traffic lights. Flow linkage: completing WD Package prompts SOW +
-- estimate version creation ('design package -> quoting'). Board's
-- phase-group template (Board v2) seeds construction phases; Design tab
-- covers the design phases — two ends of the same job."
--
-- Deliberately its own table family (design_phases / design_tasks /
-- design_task_assignees), NOT a reuse of schedule_phases/board_groups —
-- those two are already unified as ONE "construction phases" concept as
-- of migration 023 (schedule_phases.name is the single source of truth,
-- board_groups.phase_id links to it) and explicitly carry gantt dates,
-- trade contacts, and umbrella/phase kinds for the CONSTRUCTION
-- schedule. Design phases have no gantt span, no trades, no umbrella
-- concept — they are a fixed 7-step design-workflow checklist per
-- project, a genuinely separate track ("two ends of the same job" per
-- the brief above). Bolting this onto schedule_phases would mean every
-- existing gantt/board query over that table would need to start
-- excluding a `kind = 'design'` row that has no start_date/end_date
-- meaning at all — a parallel, purpose-built table family (mirroring
-- how office_groups/office_tasks got their own family in migration 021
-- rather than reusing board_groups/board_tasks) costs one migration and
-- keeps every existing schedule_phases/board_groups invariant simple.
--
-- File-boundary note: this migration is owned entirely by this task
-- (Phase 12b, the final planned phase). It does not touch
-- schedule_phases, board_groups, board_tasks, or any other prior
-- migration's tables — see PART 4 below for the one-line additive
-- exception (My Work source, no schema change) and PART 5 for the
-- Overview integration (no schema change, reads only).
--
-- Conventions carried over from every prior migration (021/023 most
-- recently):
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; design work is team work, not
--     admin-gated, and carries no pricing/financial data whatsoever —
--     see this migration's own "no pricing" note on design_tasks below)
--   - soft delete via nullable deleted_at where the spec calls for it
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate triggers & policies) so a partial
--     apply converges cleanly on re-run
-- ============================================================

-- ============================================================
-- PART 1 — design_phases
-- Seeded per project on first visit to the Design tab (NOT at
-- migration time) — same lazy "seed if the project currently has zero
-- rows" pattern as board_columns (013) and board_groups' Grouped-list
-- view (020/021), not the migration-time global seed pattern
-- schedule_phases' app_settings('phase_template') uses (023) — because
-- design_phases is genuinely PER-PROJECT data (unlike the phase
-- template, which is global settings with no project to scope a lazy
-- seed to). See app/api/projects/[id]/design/route.ts's GET handler for
-- the exact seed-on-first-visit logic and lib/design-framework.ts for
-- the shared seed list (DESIGN-FRAMEWORK-BRIEF.md's 7 phases, in board
-- order: Project Milestones, Presentation, Concepts, 3D Working Model,
-- WD Package, Renders, Sampling & Furniture — the brief's own last two
-- groups, "Sampling" and "Furniture", are combined into one phase here
-- per BUILD-SPEC.md's own task brief wording, "Sampling & Furniture",
-- which supersedes the brief's two-group board layout for this
-- lighter-weight spec-system checklist).
--
-- Fixed order, NOT reorderable (BUILD-SPEC.md task brief: "Phases
-- reorderable? No — fixed brief order, keep simple") — `sort` exists
-- for the seed's own insertion order and so a future exception is cheap
-- to add, but no route in this migration's API layer exposes a
-- reorder action.
-- ============================================================
create table if not exists design_phases (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  name          text not null,
  sort          integer not null default 0,
  status        text not null default 'not_started'
                  check (status in ('not_started', 'in_progress', 'complete', 'na')),
  started_at    timestamptz,
  completed_at  timestamptz,
  -- The WD-Package hinge (BUILD-SPEC.md: "completing WD Package prompts
  -- SOW + estimate version creation") — a ONE-TIME, dismissible prompt
  -- panel shown in the Design tab the moment the "WD Package" phase's
  -- status transitions to 'complete'. Recorded on the phase row itself
  -- (rather than a separate table) since it is exactly one boolean-ish
  -- fact about exactly one phase row per project ("has this project's
  -- WD Package hinge prompt already been shown/dismissed") — a whole
  -- extra table for a single nullable timestamp scoped 1:1 to a phase
  -- row would be over-modelling. Nullable; set once by
  -- PATCH /api/design-phases/[id] when { hinge_dismissed: true } is
  -- passed, or automatically alongside the complete transition if the
  -- team dismisses it in the same action. Meaningless (always null) on
  -- every phase row except the one named 'WD Package', but see this
  -- migration's own idempotent-seed convention note above for why a
  -- generic column beats a partial/conditional one here — the API and
  -- UI layers are the ones that only ever read/write it for the WD
  -- Package row (components/projects/design/DesignTab.tsx / this
  -- task's WdPackageHingePanel).
  hinge_dismissed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_design_phases_project on design_phases(project_id, sort);

drop trigger if exists trg_design_phases_updated_at on design_phases;
create trigger trg_design_phases_updated_at
  before update on design_phases
  for each row execute function set_updated_at();

comment on column design_phases.hinge_dismissed_at is
  'The WD-Package hinge (migration 025 / BUILD-SPEC.md "Phase 12b Design Framework"): set once the one-time "Design package complete — start quoting?" prompt panel has been dismissed for this phase row (meaningful only on the "WD Package" phase; null everywhere else). Prevents the prompt nagging on every subsequent Design tab visit. See app/api/design-phases/[id]/route.ts PATCH and components/projects/design/WdPackageHingePanel.tsx.';

-- ============================================================
-- PART 2 — design_tasks
-- Per-phase task list — title/description/due_date/sort/completed_at,
-- same "tick complete" shape as office_tasks (021) and board_tasks,
-- minus kind/prev_group_id (no archive-group concept here — a design
-- task's home phase never changes, unlike an Office task's
-- complete-and-archive-move) and, per this task's explicit
-- verification note, NO pricing/cost column anywhere on this table —
-- Design Framework is Tenille and Phillip's internal design checklist,
-- never a quoting surface (that's the Estimate module's job, downstream
-- of the WD-Package hinge below).
-- ============================================================
create table if not exists design_tasks (
  id                uuid primary key default gen_random_uuid(),
  design_phase_id   uuid not null references design_phases(id) on delete cascade,
  title             text not null,
  description       text,
  due_date          date,
  sort              integer not null default 0,
  completed_at      timestamptz,
  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create index if not exists idx_design_tasks_phase on design_tasks(design_phase_id, sort);
create index if not exists idx_design_tasks_deleted_at on design_tasks(deleted_at);
-- Supports My Work's "design_tasks assigned to me with due dates" query
-- (this migration's PART 4 doc note) — open tasks with a due date only.
create index if not exists idx_design_tasks_due_date on design_tasks(due_date) where deleted_at is null and completed_at is null;

drop trigger if exists trg_design_tasks_updated_at on design_tasks;
create trigger trg_design_tasks_updated_at
  before update on design_tasks
  for each row execute function set_updated_at();

-- ============================================================
-- PART 3 — design_task_assignees (multi-assignee, mirrors
-- board_task_assignees / office_task_assignees exactly — migration
-- 020's PART 1 comment explains the join-table-over-single-column
-- reasoning in full; not repeated here since it's identical).
-- Auto-assign-the-creator-on-create is an API-layer behaviour (see
-- POST /api/design-tasks), not enforced here.
-- ============================================================
create table if not exists design_task_assignees (
  task_id     uuid not null references design_tasks(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (task_id, profile_id)
);

create index if not exists idx_design_task_assignees_profile on design_task_assignees(profile_id);

-- ============================================================
-- Row Level Security — same Phase 1 permissive "team_all" shape as
-- every other non-financial table in this codebase (see migration
-- 020's RLS section comment for the standing rationale; not repeated in
-- full here). Design work is team work per BUILD-SPEC.md's own framing
-- ("not admin-gated — design is team work"), not admin-only.
-- ============================================================
alter table design_phases enable row level security;
alter table design_tasks enable row level security;
alter table design_task_assignees enable row level security;

drop policy if exists "team_all" on design_phases;
create policy "team_all" on design_phases
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on design_tasks;
create policy "team_all" on design_tasks
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on design_task_assignees;
create policy "team_all" on design_task_assignees
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
