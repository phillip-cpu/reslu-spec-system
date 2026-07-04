-- ============================================================
-- RESLU Specification System — Database Schema
-- Amended per BUILD-SPEC.md (authoritative, 4 July 2026).
-- Deviations from the original CLAUDE.md brief DDL are called out
-- in comments throughout.
-- ============================================================

-- ------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- updated_at trigger helper
-- BUILD-SPEC.md §Security: "updated_at triggers on all tables."
-- The original brief set DEFAULT NOW() but never updated it on
-- UPDATE (called out in the review, §2.2). Fixed here.
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- Profiles: extends Supabase auth.users
-- ============================================================
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  role        text not null default 'designer'
              check (role in ('admin', 'designer', 'viewer')),
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- ============================================================
-- Categories
-- BUILD-SPEC.md §3: "Categories are a database table, not a CHECK
-- constraint." Seeded in seed.sql with the 21 Goldsworthy-canonical
-- codes. Per-studio configurable; app generates item codes from
-- this table, so per-project drift becomes impossible.
-- ============================================================
create table categories (
  id          uuid primary key default gen_random_uuid(),
  prefix      text not null unique,   -- e.g. 'TW', 'LI', 'FA'
  name        text not null,          -- e.g. 'Tapware & Accessories'
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_categories_sort_order on categories(sort_order);

create trigger trg_categories_updated_at
  before update on categories
  for each row execute function set_updated_at();

-- ============================================================
-- Projects
-- Amended: add `budget` (BUILD-SPEC.md §1.4 / Review §1.4 — project
-- budget field with actual-vs-budget in the Pricing & Procurement view).
-- ============================================================
create table projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,               -- e.g. "Goldsworthy"
  client_name      text not null,
  address          text,
  status           text not null default 'active'
                   check (status in ('active', 'completed', 'archived')),
  budget           numeric(12,2),                -- ex-GST project budget, Pricing & Procurement view
  monday_board_id  text,                          -- procurement board ID
  client_token     text unique not null default encode(gen_random_bytes(32), 'hex'),
  created_by       uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz                    -- reserved for parity with items soft-delete; projects already use status='archived'
);

create index idx_projects_status on projects(status);
create index idx_projects_client_token on projects(client_token);

create trigger trg_projects_updated_at
  before update on projects
  for each row execute function set_updated_at();

-- ============================================================
-- Library items (global product catalogue)
-- Amended: category is now a free-text prefix referencing categories(prefix)
-- rather than a CHECK-constrained enum. Added colour/material/finish/
-- dimension fields and supplier_email for parity with project items
-- (BUILD-SPEC.md §4 / Review §1C).
-- ============================================================
create table library_items (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  supplier            text,
  supplier_email      text,
  brand               text,
  category            text not null references categories(prefix),
  location            text,                        -- typical room/area, informational only in library
  application_note    text,
  colour              text,
  material             text,
  finish              text,
  width_mm            numeric(10,2),
  height_mm           numeric(10,2),
  length_mm           numeric(10,2),
  depth_mm            numeric(10,2),
  product_url         text,
  default_image_url   text,
  image_options       jsonb not null default '[]',
  spec_sheet_url       text,
  install_manual_url   text,
  price_rrp           numeric(10,2),
  price_trade          numeric(10,2),
  tags                text[] default '{}',
  usage_count          integer not null default 0,
  created_by           uuid references profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index idx_library_category on library_items(category);
create index idx_library_supplier on library_items(supplier);
create index idx_library_usage on library_items(usage_count desc);

create trigger trg_library_items_updated_at
  before update on library_items
  for each row execute function set_updated_at();

-- ============================================================
-- Project items (spec register)
-- Amended per BUILD-SPEC.md:
--  - category: free text referencing categories(prefix), no CHECK enum
--  - location, application_note, colour, material, finish,
--    width_mm/height_mm/length_mm/depth_mm, supplier_email
--  - price_trade already present; add markup_pct for computed client price
--  - lead_time_weeks, ordered_at, eta, delivered_at (Pricing & Procurement view only)
--  - deleted_at for soft-delete (parity with projects)
--  - item_code generation is DB-side (see generate_item_code() below) —
--    no read-then-write race from the API layer.
-- ============================================================
create table items (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id) on delete cascade,
  library_item_id      uuid references library_items(id) on delete set null,

  -- Identification
  item_code            text not null,     -- e.g. LI-01, SW-04, TW-01 — DB-generated
  category             text not null references categories(prefix),

  -- Core fields
  name                 text not null,
  description          text,
  supplier             text,
  supplier_email       text,
  brand                text,
  quantity             numeric(10,3) not null default 1,
  unit                 text not null default 'ea',

  -- Location / application (Review §1.1, §1C)
  location             text,               -- room/area, e.g. "Ensuite", "Kitchen"
  application_note     text,               -- e.g. "POWDER ROOM", "ALL JOINERY HINGES"

  -- Spec fields (Review §1.2, §1C)
  colour               text,
  material             text,
  finish               text,
  width_mm             numeric(10,2),
  height_mm            numeric(10,2),
  length_mm            numeric(10,2),
  depth_mm             numeric(10,2),

  -- Status lifecycle
  status               text not null default 'Specced'
                       check (status in ('Specced', 'Quoted', 'Ordered', 'On Site', 'Installed')),

  -- Product data
  product_url          text,
  selected_image_url   text,
  image_options        jsonb not null default '[]',   -- array of image URL strings

  -- Pricing (Pricing & Procurement view only — never client portal / builder PDF)
  price_rrp            numeric(10,2),
  price_trade           numeric(10,2),
  markup_pct            numeric(6,2),                  -- applied to price_trade to compute client price

  -- Procurement (Pricing & Procurement view only)
  lead_time_weeks       numeric(6,1),
  ordered_at            date,
  eta                   date,
  delivered_at          date,

  -- Scraping state
  scrape_status         text default 'pending'
                        check (scrape_status in ('pending', 'success', 'partial', 'failed', 'vision', 'skipped')),
  scrape_attempted_at    timestamptz,
  scrape_flagged         boolean not null default false,
  scrape_flag_note       text,

  -- Client interaction
  client_approved        boolean not null default false,
  client_flagged          boolean not null default false,
  client_flag_note        text,
  client_actioned_at      timestamptz,

  -- Monday.com sync
  monday_item_id          text,
  monday_synced_at        timestamptz,

  -- Audit / soft-delete
  created_by              uuid references profiles(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz                  -- soft-delete (Review §1.9 / BUILD-SPEC.md §3)
);

-- item_code is unique per project, but only while not soft-deleted —
-- otherwise a deleted item's code could never be reused correctly and
-- a plain UNIQUE(project_id, item_code) would block legitimate re-creation.
create unique index idx_items_project_code_active
  on items(project_id, item_code) where deleted_at is null;

create index idx_items_project_id on items(project_id);
create index idx_items_category on items(project_id, category);
create index idx_items_status on items(project_id, status);
create index idx_items_deleted_at on items(deleted_at);

create trigger trg_items_updated_at
  before update on items
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- Reset client_approved when material fields change after approval
-- (BUILD-SPEC.md §7: "Material change after approval resets
-- client_approved.")
-- ------------------------------------------------------------
create or replace function reset_approval_on_material_change()
returns trigger as $$
begin
  if old.client_approved = true and (
    new.name              is distinct from old.name or
    new.description        is distinct from old.description or
    new.supplier            is distinct from old.supplier or
    new.brand               is distinct from old.brand or
    new.quantity             is distinct from old.quantity or
    new.colour               is distinct from old.colour or
    new.material              is distinct from old.material or
    new.finish                is distinct from old.finish or
    new.width_mm               is distinct from old.width_mm or
    new.height_mm               is distinct from old.height_mm or
    new.length_mm                is distinct from old.length_mm or
    new.depth_mm                  is distinct from old.depth_mm or
    new.selected_image_url        is distinct from old.selected_image_url or
    new.product_url                is distinct from old.product_url
  ) then
    new.client_approved = false;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_items_reset_approval
  before update on items
  for each row execute function reset_approval_on_material_change();

-- ============================================================
-- Item code generation — DB-side, race-safe.
-- BUILD-SPEC.md §3: "Item codes generated from prefix (TW-01…),
-- per project, in the database (unique-constraint retry, no
-- read-then-write race)."
--
-- Approach: a per-project-per-category counter table, incremented
-- atomically. This avoids both the read-then-write race the review
-- flagged (§2.2) and relies on row-level locking rather than
-- retry loops in application code.
-- ============================================================
create table item_code_counters (
  project_id   uuid not null references projects(id) on delete cascade,
  category     text not null references categories(prefix),
  next_seq     integer not null default 1,
  primary key (project_id, category)
);

create or replace function generate_item_code(p_project_id uuid, p_category text)
returns text as $$
declare
  v_seq integer;
begin
  insert into item_code_counters (project_id, category, next_seq)
  values (p_project_id, p_category, 2)
  on conflict (project_id, category)
  do update set next_seq = item_code_counters.next_seq + 1
  returning next_seq - 1 into v_seq;

  return p_category || '-' || lpad(v_seq::text, 2, '0');
end;
$$ language plpgsql;

-- Trigger: auto-assign item_code on insert if the caller left it blank.
-- Callers may still pass an explicit item_code (e.g. CSV import in Week 2)
-- but the default path (item creation from the UI/API) leaves it to the DB.
create or replace function assign_item_code()
returns trigger as $$
begin
  if new.item_code is null or new.item_code = '' then
    new.item_code := generate_item_code(new.project_id, new.category);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_items_assign_code
  before insert on items
  for each row execute function assign_item_code();

-- ============================================================
-- Item notes (attributed, timestamped)
-- ============================================================
create table item_notes (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references items(id) on delete cascade,
  author_id    uuid references profiles(id) on delete set null,
  author_name  text not null,   -- denormalised for display
  text         text not null,
  created_at   timestamptz not null default now()
);

create index idx_notes_item_id on item_notes(item_id);

-- ============================================================
-- Item files
-- BUILD-SPEC.md §5 / Review §1.7b: spec sheets and install manuals
-- stored as real files, not just external links. PDFs live in
-- Supabase Storage; this table indexes them per item.
-- ============================================================
create table item_files (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references items(id) on delete cascade,
  kind           text not null check (kind in ('spec_sheet', 'install_manual', 'other')),
  storage_path   text not null,     -- path within Supabase Storage bucket
  filename       text not null,
  uploaded_by    uuid references profiles(id) on delete set null,
  uploaded_at    timestamptz not null default now()
);

create index idx_item_files_item_id on item_files(item_id);

-- ============================================================
-- Approval events
-- BUILD-SPEC.md §7 / Review §1.6: history of approve/flag actions,
-- with an item snapshot, for dispute protection.
-- ============================================================
create table approval_events (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references items(id) on delete cascade,
  action         text not null check (action in ('approve', 'flag', 'revise')),
  note           text,
  item_snapshot  jsonb not null,     -- snapshot of item name/price/etc at time of action
  portal_token   text,               -- token used, for audit
  created_at     timestamptz not null default now()
);

create index idx_approval_events_item_id on approval_events(item_id);

-- ============================================================
-- Project ↔ library item usage tracking
-- ============================================================
create table project_library_items (
  project_id       uuid not null references projects(id) on delete cascade,
  library_item_id  uuid not null references library_items(id) on delete cascade,
  added_at         timestamptz not null default now(),
  primary key (project_id, library_item_id)
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table profiles ENABLE row level security;
alter table categories ENABLE row level security;
alter table projects ENABLE row level security;
alter table items ENABLE row level security;
alter table item_notes ENABLE row level security;
alter table item_files ENABLE row level security;
alter table approval_events ENABLE row level security;
alter table library_items ENABLE row level security;
alter table project_library_items ENABLE row level security;
alter table item_code_counters ENABLE row level security;

-- Authenticated team: full access to everything.
-- Phase 1: all team members equal; admin-only actions (e.g. settings)
-- are enforced in the API layer, not via RLS role checks — per
-- BUILD-SPEC.md §Security ("No unenforced role theatre").
create policy "team_all" on categories
  for all to authenticated using (true) with check (true);
create policy "team_all" on projects
  for all to authenticated using (true) with check (true);
create policy "team_all" on items
  for all to authenticated using (true) with check (true);
create policy "team_all" on item_notes
  for all to authenticated using (true) with check (true);
create policy "team_all" on item_files
  for all to authenticated using (true) with check (true);
create policy "team_all" on approval_events
  for all to authenticated using (true) with check (true);
create policy "team_all" on library_items
  for all to authenticated using (true) with check (true);
create policy "team_all" on project_library_items
  for all to authenticated using (true) with check (true);
create policy "team_all" on item_code_counters
  for all to authenticated using (true) with check (true);

-- Profiles: read all, update own
create policy "read_profiles" on profiles
  for select to authenticated using (true);
create policy "update_own_profile" on profiles
  for update to authenticated using (auth.uid() = id);

-- Client portal access is handled in API routes via token lookup
-- (service role key bypasses RLS server-side; the API route itself
-- is responsible for verifying the item belongs to the project
-- matching the token — BUILD-SPEC.md §Security, non-negotiable).
-- No anon-role policies are defined here on purpose: portal reads/
-- writes only ever go through the service role key from trusted
-- server code, never directly from the browser.
