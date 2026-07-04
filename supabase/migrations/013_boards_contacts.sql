-- ============================================================
-- RESLU Spec System — Week 9: Boards, Gantt, Address Book
-- BUILD-SPEC.md §"Week 9 — detailed scope" (5 July 2026).
--
-- Four features land in this single migration, per the build spec's
-- own instruction ("Migration 013_boards_contacts.sql for all of the
-- above"):
--   1. Address Book (contacts) — global, like Library.
--   2. Project board (kanban) — board_columns + board_tasks.
--   3. Procurement board — NO new table, a lens over items (see
--      components/items/**, not this migration).
--   4. Gantt — schedule_phases.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; none of this week's data is
--     financial, so there is no admin-gating requirement here, unlike
--     the Estimate/Invoices modules)
--   - soft delete via nullable deleted_at where the spec calls for it
-- ============================================================

-- ============================================================
-- PART 1 — Address Book (contacts)
-- BUILD-SPEC.md: "contacts table — company, contact_name, phone,
-- email, website, specialty, category (Appliances, Carpenters,
-- Architect, Tapware & Sanitaryware, etc. — free text w/ suggestions),
-- notes, deleted_at."
--
-- category is free text (not a FK to categories(prefix) — that table
-- is the FF&E item-code taxonomy, a completely different vocabulary
-- from trade/supplier categories like "Carpenters" or "Electrical").
-- The UI offers autocomplete suggestions from distinct existing
-- values, not a fixed enum, per "free text w/ suggestions".
-- ============================================================
create table contacts (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  contact_name  text,
  phone         text,
  email         text,
  website       text,
  specialty     text,
  category      text,
  notes         text,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index idx_contacts_category on contacts(category);
create index idx_contacts_company on contacts(company);
create index idx_contacts_deleted_at on contacts(deleted_at);

create trigger trg_contacts_updated_at
  before update on contacts
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- Link points (BUILD-SPEC.md: "board cards, cost_lines.contact_id
-- (who's quoting/doing the trade), items.supplier_contact_id
-- (optional)").
-- ------------------------------------------------------------
alter table cost_lines
  add column if not exists contact_id uuid references contacts(id) on delete set null;

alter table items
  add column if not exists supplier_contact_id uuid references contacts(id) on delete set null;

create index if not exists idx_cost_lines_contact on cost_lines(contact_id);
create index if not exists idx_items_supplier_contact on items(supplier_contact_id);

-- ============================================================
-- PART 2 — Project board (kanban)
-- BUILD-SPEC.md: "board_tasks — project_id, title, description,
-- group/column (default: To Do / In Progress / Waiting / Done —
-- per-project editable columns), assignee (profile), contact_id
-- (linked trade/supplier), due_date, sort, timestamps, soft delete."
--
-- Modelled as two tables (board_columns + board_tasks) rather than a
-- free-text "group" column on board_tasks, so columns can be renamed/
-- added/deleted independently of the tasks inside them (the build
-- spec's "per-project editable columns" and the detailed brief's
-- "rename/add/delete columns (delete only when empty)" both require
-- columns to be first-class, addressable rows — a text label alone
-- can't be renamed in one place and have every task's card follow
-- along without a mass-update, and can't be safely deleted-when-empty
-- without a row to check for referencing tasks against).
-- ============================================================
create table board_columns (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_board_columns_project on board_columns(project_id, sort);

create trigger trg_board_columns_updated_at
  before update on board_columns
  for each row execute function set_updated_at();

create table board_tasks (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  column_id     uuid not null references board_columns(id) on delete cascade,
  title         text not null,
  description   text,
  assignee_id   uuid references profiles(id) on delete set null,
  contact_id    uuid references contacts(id) on delete set null,
  due_date      date,
  -- Sort scheme: a float-free integer ladder, gaps of 1000 between
  -- siblings within a column (see app/api/projects/[id]/board/route.ts
  -- POST — new cards land at max(sort)+1000). Reordering within/across
  -- columns (PATCH /api/board-tasks/[id]) renumbers only the cards
  -- actually needed via straightforward integer arithmetic — full
  -- fractional-index schemes were judged unnecessary complexity for
  -- this tool's card counts. Documented in full in docs/API.md's
  -- "Address Book, Project board & Gantt — Week 9" section (formerly
  -- docs/API-week9-additions.md, folded in and deleted in Week 10).
  sort          integer not null default 0,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index idx_board_tasks_project on board_tasks(project_id);
create index idx_board_tasks_column on board_tasks(column_id, sort);
create index idx_board_tasks_deleted_at on board_tasks(deleted_at);

create trigger trg_board_tasks_updated_at
  before update on board_tasks
  for each row execute function set_updated_at();

-- Note: board_columns are seeded per-project on FIRST VISIT (To Do /
-- In Progress / Waiting / Done), not by this migration — see
-- GET /api/projects/[id]/board, which seeds idempotently (only if the
-- project has zero columns) rather than a migration-time backfill
-- across every existing project, so a project nobody has opened the
-- Board tab for yet carries no dead rows.

-- ============================================================
-- PART 3 — Procurement board: NO new table. It's a kanban VIEW over
-- the existing `items` table, grouped by the existing `status` column
-- (Specced/Quoted/Ordered/On Site/Installed) — drag-to-change-status
-- goes through the EXISTING PATCH /api/items/[id] route (which already
-- fire-and-forgets the Monday sync on a transition to "Ordered"), never
-- a new table or a new write path. See components/items/BoardView.tsx.
-- ============================================================

-- ============================================================
-- PART 4 — Gantt (schedule_phases)
-- BUILD-SPEC.md: "schedule_phases — project_id, name, start_date,
-- end_date, color_key (subset of brand-safe palette), contact_id?,
-- sort, notes." Detailed scope: "color_key text default 'sand' check
-- in ('sand','charcoal','teal','amber')" — teal/amber are additional
-- brand-safe accent tones for Gantt bar variety beyond the strict
-- brand guide's sand-only-accent rule (small bars, not "large fills",
-- so the brand guide's "sand accents only, never large fills" is
-- satisfied — these are used for differentiation between phases, not
-- as large decorative blocks).
-- ============================================================
create table schedule_phases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  color_key   text not null default 'sand'
              check (color_key in ('sand', 'charcoal', 'teal', 'amber')),
  contact_id  uuid references contacts(id) on delete set null,
  sort        integer not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint chk_schedule_phases_dates check (end_date >= start_date)
);

create index idx_schedule_phases_project on schedule_phases(project_id, sort);
create index idx_schedule_phases_deleted_at on schedule_phases(deleted_at);

create trigger trg_schedule_phases_updated_at
  before update on schedule_phases
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — same Phase 1 "team_all" shape as every other
-- non-financial, non-append-only table in this codebase. None of this
-- week's tables carry financial data (contacts are trade/supplier
-- directory info; boards and phases are scheduling/task data), so
-- there is no admin-gating requirement — enforcement (where any is
-- needed, e.g. "delete column only when empty") lives in the API
-- layer, per BUILD-SPEC.md §Security's "no unenforced role theatre".
-- ============================================================
alter table contacts enable row level security;
alter table board_columns enable row level security;
alter table board_tasks enable row level security;
alter table schedule_phases enable row level security;

create policy "team_all" on contacts
  for all to authenticated using (true) with check (true);
create policy "team_all" on board_columns
  for all to authenticated using (true) with check (true);
create policy "team_all" on board_tasks
  for all to authenticated using (true) with check (true);
create policy "team_all" on schedule_phases
  for all to authenticated using (true) with check (true);

-- cost_lines and items already have "team_all" policies from
-- 007_estimating.sql / 001_initial.sql — the new contact_id/
-- supplier_contact_id columns added in PART 1 are covered by those
-- existing policies automatically (RLS policies apply at the row
-- level, not per-column).
