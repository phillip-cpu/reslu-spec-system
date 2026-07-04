-- ============================================================
-- RESLU Spec System — Week 9: Boards, Gantt, Address Book
-- BUILD-SPEC.md §"Week 9 — detailed scope" (5 July 2026).
--
-- Features: Address Book (contacts), Project board (board_columns +
-- board_tasks), Procurement board (a lens over items — no table), Gantt
-- (schedule_phases). See components/items/** and the API routes.
--
-- Idempotent throughout (create ... if not exists / add column if not
-- exists / drop-then-create for triggers & policies) so it is safe to
-- re-run after a partial apply — hot-table ALTERs can time out against a
-- live app and get skipped, and create-table/policy without guards would
-- then error on the retry. Re-running this whole file always converges.
-- ============================================================

-- ============================================================
-- PART 1 — Address Book (contacts). category is free text (trade/
-- supplier vocabulary, distinct from the FF&E categories(prefix) taxonomy).
-- ============================================================
create table if not exists contacts (
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

create index if not exists idx_contacts_category on contacts(category);
create index if not exists idx_contacts_company on contacts(company);
create index if not exists idx_contacts_deleted_at on contacts(deleted_at);

drop trigger if exists trg_contacts_updated_at on contacts;
create trigger trg_contacts_updated_at
  before update on contacts
  for each row execute function set_updated_at();

-- Link points: cost_lines.contact_id (who's quoting/doing the trade),
-- items.supplier_contact_id (optional supplier link).
alter table cost_lines
  add column if not exists contact_id uuid references contacts(id) on delete set null;

alter table items
  add column if not exists supplier_contact_id uuid references contacts(id) on delete set null;

create index if not exists idx_cost_lines_contact on cost_lines(contact_id);
create index if not exists idx_items_supplier_contact on items(supplier_contact_id);

-- ============================================================
-- PART 2 — Project board (kanban): board_columns + board_tasks.
-- Columns are first-class rows (per-project rename/add/delete). Columns
-- are seeded per-project on first visit by GET /api/projects/[id]/board,
-- not here.
-- ============================================================
create table if not exists board_columns (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_board_columns_project on board_columns(project_id, sort);

drop trigger if exists trg_board_columns_updated_at on board_columns;
create trigger trg_board_columns_updated_at
  before update on board_columns
  for each row execute function set_updated_at();

create table if not exists board_tasks (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  column_id     uuid not null references board_columns(id) on delete cascade,
  title         text not null,
  description   text,
  assignee_id   uuid references profiles(id) on delete set null,
  contact_id    uuid references contacts(id) on delete set null,
  due_date      date,
  sort          integer not null default 0,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists idx_board_tasks_project on board_tasks(project_id);
create index if not exists idx_board_tasks_column on board_tasks(column_id, sort);
create index if not exists idx_board_tasks_deleted_at on board_tasks(deleted_at);

drop trigger if exists trg_board_tasks_updated_at on board_tasks;
create trigger trg_board_tasks_updated_at
  before update on board_tasks
  for each row execute function set_updated_at();

-- PART 3 — Procurement board: NO new table (a kanban view over items,
-- grouped by items.status; drag-to-change goes through PATCH /api/items/[id]).

-- ============================================================
-- PART 4 — Gantt (schedule_phases). color_key: brand-safe accents on
-- small bars (not large fills), so the brand guide is satisfied.
-- ============================================================
create table if not exists schedule_phases (
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

create index if not exists idx_schedule_phases_project on schedule_phases(project_id, sort);
create index if not exists idx_schedule_phases_deleted_at on schedule_phases(deleted_at);

drop trigger if exists trg_schedule_phases_updated_at on schedule_phases;
create trigger trg_schedule_phases_updated_at
  before update on schedule_phases
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — Phase 1 "team_all" per table.
-- ============================================================
alter table contacts enable row level security;
alter table board_columns enable row level security;
alter table board_tasks enable row level security;
alter table schedule_phases enable row level security;

drop policy if exists "team_all" on contacts;
create policy "team_all" on contacts
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on board_columns;
create policy "team_all" on board_columns
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on board_tasks;
create policy "team_all" on board_tasks
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on schedule_phases;
create policy "team_all" on schedule_phases
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
