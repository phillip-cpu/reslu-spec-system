-- ============================================================
-- RESLU Spec System — Estimating module ("the Excel killer")
-- BUILD-SPEC.md §"Project estimating module", §"Estimating module —
-- enriched from Phillip's Excel template", §"Invoice pipeline —
-- AI-updated actuals".
--
-- Everything in this migration is admin-only financial data, enforced
-- server-side in the API layer (see app/api/projects/[id]/estimate/**
-- and app/api/estimate/**) — never merely hidden in the UI, per
-- BUILD-SPEC.md §Financial visibility. RLS here follows the same
-- "team_all" shape as 001_initial.sql (Phase 1: no unenforced role
-- theatre at the RLS layer — the API layer is the enforcement point,
-- exactly like price_trade on library_items/items today).
--
-- Conventions carried over from 001_initial.sql:
--   - uuid pks via gen_random_uuid() (pgcrypto already enabled in 001)
--   - set_updated_at() trigger helper (already defined in 001) reused
--     here, not redefined
--   - RLS enabled + a single permissive "team_all" policy per table
--   - soft delete via nullable deleted_at where the spec calls for it
-- ============================================================

-- ------------------------------------------------------------
-- projects: whole-job markup input for the Estimate summary block.
-- numeric(5,4) → stores a fraction, e.g. 0.1500 = 15.00%. The API/UI
-- layer is responsible for the fraction↔percent display conversion
-- (see lib/estimate.ts).
-- ------------------------------------------------------------
alter table projects
  add column if not exists estimate_markup_pct numeric(5,4) not null default 0;

-- ============================================================
-- Master estimate template (editable in Settings — out of this
-- migration's file boundary for UI, but the tables live here since
-- they're estimating-schema. Seeded by supabase/seed_estimate_template.sql).
-- ============================================================
create table estimate_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_estimate_templates_updated_at
  before update on estimate_templates
  for each row execute function set_updated_at();

-- Only one default template at a time — the init route
-- (POST /api/projects/[id]/estimate/init) looks up is_default = true.
create unique index idx_estimate_templates_one_default
  on estimate_templates (is_default) where is_default;

create table estimate_template_sections (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references estimate_templates(id) on delete cascade,
  name         text not null,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_estimate_template_sections_template
  on estimate_template_sections(template_id, sort);

create trigger trg_estimate_template_sections_updated_at
  before update on estimate_template_sections
  for each row execute function set_updated_at();

create table estimate_template_lines (
  id           uuid primary key default gen_random_uuid(),
  section_id   uuid not null references estimate_template_sections(id) on delete cascade,
  description  text not null,
  unit         text,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_estimate_template_lines_section
  on estimate_template_lines(section_id, sort);

create trigger trg_estimate_template_lines_updated_at
  before update on estimate_template_lines
  for each row execute function set_updated_at();

-- ============================================================
-- Per-project cost sections + lines — the live Estimate tab data.
-- Seeded from the default template via POST
-- /api/projects/[id]/estimate/init (idempotent: 409 if sections
-- already exist for the project).
-- ============================================================
create table cost_sections (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_cost_sections_project on cost_sections(project_id, sort);

create trigger trg_cost_sections_updated_at
  before update on cost_sections
  for each row execute function set_updated_at();

create table cost_lines (
  id                        uuid primary key default gen_random_uuid(),
  section_id                uuid not null references cost_sections(id) on delete cascade,
  -- Denormalised for queries that need "all cost lines for a project"
  -- without joining through cost_sections (e.g. all-trades rollup,
  -- invoice matching by project). Kept in sync at write time by the
  -- API layer (section_id's project always matches project_id — the
  -- API validates this on insert/patch, see estimate lines route).
  project_id                uuid not null references projects(id) on delete cascade,
  description               text not null,
  qty                       numeric(12,3),
  unit                      text,
  rate_ex_gst               numeric(12,2),
  -- Manual override. When null, the app computes qty * rate_ex_gst
  -- (see lib/estimate.ts lineCost()) — this column is NOT a generated
  -- column on purpose, since the Excel workflow sometimes hand-enters
  -- a lump-sum cost with no meaningful qty/rate split.
  cost_ex_gst               numeric(12,2),
  quoted_to_client_ex_gst   numeric(12,2),
  actual_paid_ex_gst        numeric(12,2),
  quote_status              text check (quote_status in ('Q', 'S', 'NA')),
  -- Ties an estimate line to a spec register item (e.g. tapware supply
  -- lines) — BUILD-SPEC.md "enriched from Phillip's Excel template".
  item_id                   uuid references items(id) on delete set null,
  notes                     text,
  sort                      integer not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz
);

create index idx_cost_lines_section on cost_lines(section_id, sort);
create index idx_cost_lines_project on cost_lines(project_id);
create index idx_cost_lines_item on cost_lines(item_id);
create index idx_cost_lines_deleted_at on cost_lines(deleted_at);

create trigger trg_cost_lines_updated_at
  before update on cost_lines
  for each row execute function set_updated_at();

-- ============================================================
-- Variations register
-- BUILD-SPEC.md: "var number (auto), date, description, cost ex/inc
-- GST, status, approved_by, requested_by, notes, optional item_code
-- link. Variations total feeds the Contingency section's 'Approved
-- variations' line."
-- ============================================================
create table variations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  -- Auto-numbered per project. The API computes max(var_number)+1 per
  -- project at insert time (small-scale, low-concurrency internal tool —
  -- a DB-side counter table like item_code_counters was judged overkill
  -- here; documented so a future migration can promote it if variations
  -- volume ever grows enough for the race to matter in practice).
  var_number     integer not null,
  var_date       date not null default current_date,
  description    text not null,
  cost_ex_gst    numeric(12,2) not null default 0,
  status         text not null default 'proposed'
                 check (status in ('proposed', 'approved', 'rejected')),
  approved_by    text,
  requested_by   text,
  item_id        uuid references items(id) on delete set null,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- var_number unique per project among non-deleted rows (mirrors the
-- items.item_code pattern in 001_initial.sql — deleting a variation
-- must not permanently retire its number for legitimate re-creation
-- of the counter's next value, but two *active* variations must never
-- collide).
create unique index idx_variations_project_number_active
  on variations(project_id, var_number) where deleted_at is null;

create index idx_variations_project on variations(project_id);
create index idx_variations_item on variations(item_id);
create index idx_variations_deleted_at on variations(deleted_at);

create trigger trg_variations_updated_at
  before update on variations
  for each row execute function set_updated_at();

-- ============================================================
-- Areas & Measurements
-- BUILD-SPEC.md: "grouped measurement lines (Floor Areas, Tiling Areas
-- — groups editable), room/area, measurement, unit (m2 default),
-- notes, optional item_code link. Totals per group."
-- ============================================================
create table measurement_groups (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_measurement_groups_project on measurement_groups(project_id, sort);

create trigger trg_measurement_groups_updated_at
  before update on measurement_groups
  for each row execute function set_updated_at();

create table measurements (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references measurement_groups(id) on delete cascade,
  -- Denormalised for the same reason as cost_lines.project_id — lets
  -- the API fetch/aggregate all measurements for a project without a
  -- join through measurement_groups.
  project_id  uuid not null references projects(id) on delete cascade,
  label       text not null,       -- e.g. room/area name
  value       numeric(12,3) not null default 0,
  unit        text not null default 'm2',
  item_id     uuid references items(id) on delete set null,
  notes       text,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_measurements_group on measurements(group_id, sort);
create index idx_measurements_project on measurements(project_id);
create index idx_measurements_item on measurements(item_id);

create trigger trg_measurements_updated_at
  before update on measurements
  for each row execute function set_updated_at();

-- ============================================================
-- Invoices — schema only this week, no UI (BUILD-SPEC.md "Invoice
-- pipeline — AI-updated actuals"). Lands with the estimate migration
-- now so nothing needs re-plumbing when the queue UI/Aria integration
-- ships (Phase 1.5–2).
-- ============================================================
create table invoices (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects(id) on delete cascade,
  supplier              text not null,
  invoice_number        text not null,
  invoice_date          date,
  amount_ex_gst         numeric(12,2) not null,
  gst                   numeric(12,2) not null default 0,
  total                 numeric(12,2) not null,
  storage_path          text,           -- Supabase Storage path of the source PDF
  proposed_match_type   text check (proposed_match_type in ('cost_line', 'item')),
  proposed_match_id     uuid,           -- references cost_lines(id) or items(id) depending on proposed_match_type — no single-table FK possible, validated in the API layer
  confidence_note       text,
  status                text not null default 'unmatched'
                        check (status in ('unmatched', 'proposed', 'approved', 'rejected')),
  approved_by           uuid references profiles(id) on delete set null,
  approved_at           timestamptz,
  created_by            uuid references profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- "Unique warn index on (project_id, supplier, invoice_number)" per the
-- build spec — a partial unique index that excludes rejected invoices,
-- so a rejected duplicate can still be re-submitted/reprocessed without
-- fighting the constraint, but two live (unmatched/proposed/approved)
-- invoices for the same supplier+number in the same project collide.
-- "Warn" rather than hard-block is enforced at the API layer (23505 on
-- this index is caught and surfaced as a 409 with a clear message,
-- rather than a generic 500) — see app/api/estimate/invoices/route.ts
-- note: invoices UI/route beyond schema is deferred, but the index
-- must exist now per the build spec so later work doesn't need a
-- migration just to add it.
create unique index idx_invoices_project_supplier_number_live
  on invoices(project_id, supplier, invoice_number) where status != 'rejected';

create index idx_invoices_project on invoices(project_id);
create index idx_invoices_status on invoices(project_id, status);

create trigger trg_invoices_updated_at
  before update on invoices
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security
-- Same Phase 1 shape as 001_initial.sql: authenticated team gets a
-- single permissive policy; the real enforcement for financial data
-- is the API-layer admin check (BUILD-SPEC.md §Financial visibility:
-- "API responses strip financial fields for non-admin sessions (not
-- merely hidden in UI)"; for the Estimate module specifically, the
-- whole surface is financial, so non-admin requests are rejected with
-- 403 before any query runs, rather than field-stripped like
-- library_items/items — see app/api/projects/[id]/estimate/route.ts).
-- ============================================================
alter table estimate_templates enable row level security;
alter table estimate_template_sections enable row level security;
alter table estimate_template_lines enable row level security;
alter table cost_sections enable row level security;
alter table cost_lines enable row level security;
alter table variations enable row level security;
alter table measurement_groups enable row level security;
alter table measurements enable row level security;
alter table invoices enable row level security;

create policy "team_all" on estimate_templates
  for all to authenticated using (true) with check (true);
create policy "team_all" on estimate_template_sections
  for all to authenticated using (true) with check (true);
create policy "team_all" on estimate_template_lines
  for all to authenticated using (true) with check (true);
create policy "team_all" on cost_sections
  for all to authenticated using (true) with check (true);
create policy "team_all" on cost_lines
  for all to authenticated using (true) with check (true);
create policy "team_all" on variations
  for all to authenticated using (true) with check (true);
create policy "team_all" on measurement_groups
  for all to authenticated using (true) with check (true);
create policy "team_all" on measurements
  for all to authenticated using (true) with check (true);
create policy "team_all" on invoices
  for all to authenticated using (true) with check (true);
