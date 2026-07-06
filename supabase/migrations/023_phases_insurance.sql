-- ============================================================
-- RESLU Spec System — Fix Round A: phase unification, pre-populated
-- phase template, Site Setup umbrella span fix (application-layer,
-- see lib/gantt.ts/lib/trade-visits.ts changes in this same task),
-- vertical board layout (no schema — UI only), trade insurance
-- tracker.
-- BUILD-SPEC.md "Phase 14 follow-ups from Phillip's testing" items
-- 1, 2, 3, 4 + "Board vertical layout".
--
-- File-boundary note: this migration is owned entirely by this task.
-- A separate agent works concurrently in this same working copy on
-- ProcurementBoardView, leads components, office board, Sidebar/
-- badges, the portal selections page, SowBuilder, rate-limit/upload
-- libs, and mcp/** — none of those are touched here, and this
-- migration does not touch any table those files own.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; none of this round's new tables
--     are financial)
--   - soft delete via nullable deleted_at where the spec calls for it
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate triggers & policies) so a partial
--     apply converges cleanly on re-run
-- ============================================================

-- ============================================================
-- PART 1 — Phase unification: board_groups <-> schedule_phases
-- BUILD-SPEC.md "Timeline vs Board roles feel clunky": "UNIFY phases
-- — one `phases` concept: board phase-groups and timeline phases
-- become the same rows (board groups gain optional dates / schedule_
-- phases become the board's groups)."
--
-- Design chosen (documented in full in this task's build report and
-- in docs/API.md's new "Phase unification — Fix Round A" section):
-- schedule_phases.name is the SINGLE SOURCE OF TRUTH. board_groups
-- gains a nullable phase_id FK back to schedule_phases. Renaming
-- either side keeps the two in sync (API layer, see
-- app/api/phases/[id]/route.ts PATCH and app/api/board-groups/[id]/
-- route.ts PATCH in this task): a board_groups row with a non-null
-- phase_id has its `name` column overwritten to mirror
-- schedule_phases.name on every write to either side; a board_groups
-- row with phase_id null (never linked — see backfill below) keeps
-- its own independent name.
--
-- board_groups.name is NOT dropped (kept per this task's brief:
-- "keep column, sync on write, comment deprecation") because
-- BoardGroupWithTasks/every existing SELECT * over board_groups
-- still needs a `name` to render without a join in the common case,
-- and because an unlinked/legacy group (created before this migration
-- and never matched to a phase — see backfill note) has no other
-- place to keep its label.
-- ============================================================
alter table board_groups
  add column if not exists phase_id uuid references schedule_phases(id) on delete set null;

create index if not exists idx_board_groups_phase on board_groups(phase_id);

comment on column board_groups.name is
  'DEPRECATED as an independent value (migration 023) when phase_id is set — schedule_phases.name is the single source of truth for a unified phase''s label. The API layer (PATCH /api/phases/[id], PATCH /api/board-groups/[id]) keeps this column mirrored on every write to either side so every existing SELECT * over board_groups still renders a correct label without a join. A board_groups row with phase_id IS NULL (pre-unification groups never matched to a schedule_phases row — see this migration''s data-migration block) keeps this column as its own independent, authoritative label. See BUILD-SPEC.md "Timeline vs Board roles feel clunky" and docs/API.md "Phase unification — Fix Round A".';

comment on column board_groups.phase_id is
  'Fix Round A phase unification (migration 023). Links a board phase-group to its unified schedule_phases row. NULL means either (a) this project has not yet unified this group with a phase (pre-migration data not matched by name — see backfill below), or (b) legacy data the team has not reconciled. Henceforth: creating a schedule_phases row (POST /api/projects/[id]/phases) creates/links a board_groups row and vice versa (POST /api/projects/[id]/board/groups and the groups/seed route) — see each route''s doc comment for the exact invariant. A board_groups row with phase_id set represents an UMBRELLA-kind phase only when its linked schedule_phases.kind = ''umbrella''; ordinary phase groups link to kind=''phase'' rows.';

-- ------------------------------------------------------------
-- Data migration — match existing board_groups to schedule_phases by
-- case-insensitive name, per project. BUILD-SPEC.md: "for each project
-- with both, match board_groups.name = schedule_phases.name
-- (case-insensitive) and link; unmatched board_groups create a
-- schedule_phase (no dates yet, flagged)."
--
-- Step 1: link matches (case-insensitive, trimmed, within the same
-- project, only to 'phase'-kind rows — never auto-link to the
-- system-maintained 'umbrella' row by name coincidence).
-- ------------------------------------------------------------
update board_groups bg
set phase_id = sp.id
from schedule_phases sp
where bg.phase_id is null
  and sp.project_id = bg.project_id
  and sp.deleted_at is null
  and sp.kind = 'phase'
  and lower(trim(sp.name)) = lower(trim(bg.name));

-- ------------------------------------------------------------
-- Step 2: unmatched board_groups (still phase_id is null after the
-- above) each get a brand-new schedule_phases row created for them —
-- "no dates yet, flagged". schedule_phases.start_date/end_date are
-- NOT NULL (migration 013), so "no dates yet" is represented as
-- today's date for both (a zero-length placeholder span) plus a
-- distinguishing note so the Timeline UI can flag it for the team to
-- set real dates, per the spec's own "(no dates yet, flagged)"
-- wording — see components/gantt/GanttChart.tsx's "needs dates" badge
-- (this task) which renders whenever notes contains this exact marker
-- prefix, and lib/phase-template.ts's PHASE_NEEDS_DATES_NOTE constant
-- (the single source of truth for the marker string both this
-- migration and the UI check against).
-- ------------------------------------------------------------
insert into schedule_phases (project_id, name, start_date, end_date, sort, notes)
select
  bg.project_id,
  bg.name,
  current_date,
  current_date,
  -- Sort after every existing phase for that project so newly-created
  -- placeholder phases land at the end of the Timeline, not jumbled
  -- into the middle of a project's real schedule.
  coalesce((select max(sp2.sort) from schedule_phases sp2 where sp2.project_id = bg.project_id and sp2.deleted_at is null), 0) + 1000,
  '[unification: needs dates] Created automatically from board group "' || bg.name || '" during Fix Round A phase unification (migration 023) — set real start/end dates.'
from board_groups bg
where bg.phase_id is null;

-- Link the just-created rows back (same case-insensitive match now
-- succeeds since the schedule_phases row was created from the exact
-- board_groups.name moments ago).
update board_groups bg
set phase_id = sp.id
from schedule_phases sp
where bg.phase_id is null
  and sp.project_id = bg.project_id
  and sp.deleted_at is null
  and sp.kind = 'phase'
  and lower(trim(sp.name)) = lower(trim(bg.name));

-- ============================================================
-- PART 2 — Pre-populated phases: shared seed template
-- BUILD-SPEC.md "Timeline phases pre-populated": "seed schedule_phases
-- from an editable framework template on first visit (like board
-- groups); template in Settings; align defaults with the Monday
-- project board's phase structure." + "Board v2" point 3's original
-- DEFAULT_PHASE_GROUPS list, now superseded (see below).
--
-- app_settings — simple key/value settings store, first table of its
-- kind in this schema (every prior "setting" — categories, board
-- columns, phase groups — has been its own first-class table). A
-- single generic key/value table is the right shape here specifically
-- because the ONLY consumer is a single editable text-list (the phase
-- template) with no relational structure of its own (no per-row id,
-- no FK targets) — modelling it as its own dedicated table would mean
-- a table with exactly one conceptual row per key, which is exactly
-- what a key/value store is for. Deliberately generic (jsonb value)
-- so a future second setting doesn't need its own migration.
-- ============================================================
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_app_settings_updated_at on app_settings;
create trigger trg_app_settings_updated_at
  before update on app_settings
  for each row execute function set_updated_at();

alter table app_settings enable row level security;
drop policy if exists "team_all" on app_settings;
create policy "team_all" on app_settings
  for all to authenticated using (true) with check (true);

-- Seed the 'phase_template' key with the unified default list —
-- BUILD-SPEC.md "Pre-populated phases": "Site Setup (umbrella),
-- Demolition, Rough-in, Waterproofing & Tiling, Fit-off, Handover".
-- This REPLACES the old hardcoded DEFAULT_PHASE_GROUPS constant
-- (types/phase-12a-b.ts) as the seed source for BOTH the Timeline and
-- the Board's Grouped-list view — see lib/phase-template.ts (this
-- task) for the shared seed path both now call, and that file's doc
-- comment for why "Site Prep" became "Site Setup (umbrella)" here
-- (aligning the two previously-divergent default lists is the whole
-- point of unification). Seeded once at migration time (unlike every
-- other "seed on first visit" pattern in this codebase) because this
-- is genuinely global settings data, not per-project — there is no
-- "project" to scope a lazy seed to; Settings needs a row to display
-- and edit from the very first page load.
insert into app_settings (key, value)
values (
  'phase_template',
  '[
    {"name": "Site Setup", "kind": "umbrella"},
    {"name": "Demolition", "kind": "phase"},
    {"name": "Rough-in", "kind": "phase"},
    {"name": "Waterproofing & Tiling", "kind": "phase"},
    {"name": "Fit-off", "kind": "phase"},
    {"name": "Handover", "kind": "phase"}
  ]'::jsonb
)
on conflict (key) do nothing;

-- ============================================================
-- PART 3 — Trade insurance tracker
-- BUILD-SPEC.md "Trade insurance compliance (Aria-managed)": "migration
-- 023: contact_documents (id, contact_id cascade, kind check in
-- ('public_liability','workers_comp','licence','other'), storage_path,
-- filename, expiry_date, verified_at, uploaded_by, created_at,
-- deleted_at)."
--
-- contact_id is ON DELETE CASCADE (unlike every other contact_id FK
-- in this schema, e.g. schedule_phases.contact_id/trade_visits.
-- contact_id, which are all ON DELETE SET NULL) because a
-- contact_documents row has ZERO standalone meaning once its contact
-- is gone — it is literally that contact's insurance/licence
-- paperwork, not a scheduling record with its own historical value.
-- Deleting a contact's Address Book entry should take its uploaded
-- compliance documents with it (and their Storage objects — see
-- DELETE /api/contacts/[id]/route.ts's existing handler, which this
-- task extends to also clean up contact_documents' Storage objects
-- before the cascade fires, since a DB cascade alone would leave
-- orphaned Storage objects behind).
-- ============================================================
create table if not exists contact_documents (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references contacts(id) on delete cascade,
  kind          text not null check (kind in ('public_liability', 'workers_comp', 'licence', 'other')),
  storage_path  text not null,
  filename      text not null,
  expiry_date   date,
  verified_at   timestamptz,
  uploaded_by   uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists idx_contact_documents_contact on contact_documents(contact_id);
create index if not exists idx_contact_documents_expiry on contact_documents(expiry_date);
create index if not exists idx_contact_documents_deleted_at on contact_documents(deleted_at);

alter table contact_documents enable row level security;
drop policy if exists "team_all" on contact_documents;
create policy "team_all" on contact_documents
  for all to authenticated using (true) with check (true);

-- Note: contact_documents has no updated_at/trigger — a document's
-- expiry_date/verified_at are edited via PATCH (rare — usually a
-- fresh document is uploaded instead of an old one edited), and every
-- other soft-deletable "attachment" table in this schema (item_files,
-- project_files) also has no updated_at, for the same reason: these
-- rows are close to write-once, read-many, with delete-and-reupload
-- as the normal "update" workflow rather than in-place field edits.

notify pgrst, 'reload schema';
