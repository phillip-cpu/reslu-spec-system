-- ============================================================
-- RESLU Spec System — Week 8A: Project overview hub, document
-- traffic lights, Scope of Works builder.
-- BUILD-SPEC.md "Project overview hub", "Scope of Works builder".
--
-- Conventions carried over from prior migrations:
--   - uuid pks via gen_random_uuid() (pgcrypto already enabled in 001)
--   - set_updated_at() trigger helper (already defined in 001) reused
--     here, not redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1: no
--     unenforced role theatre at the RLS layer — enforcement for
--     anything that needs it lives in the API layer)
--   - idempotent: every statement guarded (add column if not exists /
--     create table if not exists / drop+recreate constraints) so this
--     can be re-run safely, matching 007/009's style
-- ============================================================

-- ------------------------------------------------------------
-- PART 1 — Document traffic lights
-- BUILD-SPEC.md "Project overview hub": "Status is a manual
-- per-project setting per kind ... JSON on projects: kind → status in
-- ('na','not_started','draft','done')". Stored as jsonb keyed by
-- ProjectFileKind ('plans'|'council'|'engineering'|'scope_of_works'|
-- 'other') rather than a new table — a handful of small enum values
-- per project doesn't need a join, and the API/UI treat an absent key
-- as the "default for its kind" (red/not_started for the four
-- tracked kinds on active projects) rather than persisting that
-- default up front, so a fresh project needs no seed step here.
-- ------------------------------------------------------------
alter table projects
  add column if not exists document_status jsonb not null default '{}';

-- ============================================================
-- PART 2 — Scope of Works builder
-- BUILD-SPEC.md "Scope of Works builder": structured sections → line
-- items (room-by-room, inclusions/exclusions), versioned (T1/T2
-- revisions), rendered to a branded PDF, shareable to the portal.
-- ============================================================

create table if not exists sow_documents (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  -- e.g. "T1", "T2" — mirrors project_files.revision_label's free-text
  -- tender-set convention rather than a numeric column, since RESLU's
  -- existing convention (plans/council T1/T2/T3) is already text.
  revision_label  text not null,
  status          text not null default 'draft'
                  check (status in ('draft', 'issued')),
  issued_at       timestamptz,
  created_by      uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

-- revision_label unique per project among non-deleted rows (mirrors
-- items.item_code / variations.var_number's partial-unique pattern).
create unique index idx_sow_documents_project_revision_active
  on sow_documents(project_id, revision_label) where deleted_at is null;

create index if not exists idx_sow_documents_project on sow_documents(project_id, deleted_at);

create trigger trg_sow_documents_updated_at
  before update on sow_documents
  for each row execute function set_updated_at();

create table if not exists sow_sections (
  id          uuid primary key default gen_random_uuid(),
  sow_id      uuid not null references sow_documents(id) on delete cascade,
  heading     text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_sow_sections_sow on sow_sections(sow_id, sort);

create trigger trg_sow_sections_updated_at
  before update on sow_sections
  for each row execute function set_updated_at();

create table if not exists sow_lines (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references sow_sections(id) on delete cascade,
  text        text not null,
  kind        text not null default 'inclusion'
              check (kind in ('inclusion', 'exclusion', 'note')),
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_sow_lines_section on sow_lines(section_id, sort);

create trigger trg_sow_lines_updated_at
  before update on sow_lines
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- Row Level Security — same Phase 1 shape as every other table: a
-- single permissive "team_all" policy for authenticated users. SOW
-- CRUD is team access per BUILD-SPEC.md (not admin-gated — a SOW is
-- not financial data), enforced identically at the API layer.
-- ------------------------------------------------------------
alter table sow_documents enable row level security;
alter table sow_sections enable row level security;
alter table sow_lines enable row level security;

drop policy if exists "team_all" on sow_documents;
create policy "team_all" on sow_documents  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on sow_sections;
create policy "team_all" on sow_sections  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on sow_lines;
create policy "team_all" on sow_lines  for all to authenticated using (true) with check (true);
