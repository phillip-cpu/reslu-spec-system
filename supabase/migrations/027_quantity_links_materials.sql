-- ============================================================
-- RESLU Spec System — Round B: takeoff → FF&E quantity links +
-- materials price list.
-- BUILD-SPEC.md "Pricing division — Estimates = labour, FF&E =
-- products" (takeoff→FF&E links half) + "Phillip's ideas list — 6 July
-- 2026" item 4 (calculators incl. materials price list). See the
-- DECISIONS paragraph above item 5 in that list: NO framing defaults —
-- every calculator input starts empty, nothing here seeds a "typical"
-- stud spacing/sheet size/etc. That decision affects app code only
-- (lib/calculators.ts / components/calculators/**); it doesn't change
-- anything about this migration's shape.
--
-- Conventions carried over from prior migrations (007/019/023):
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (001_initial.sql) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 — no
--     unenforced role theatre at the RLS layer; the API layer is the
--     enforcement point for anything financial, exactly like
--     cost_lines/measurements in 007_estimating.sql and materials here)
--   - idempotent throughout (add column if not exists / create table
--     if not exists / drop+recreate triggers) so a partial apply
--     converges cleanly on re-run
--
-- File-boundary note: this migration touches `items` (adding columns
-- only — no existing column is altered/dropped) and creates a new
-- `materials` table. It does not touch any Round A table
-- (schedule_phases, board columns, etc.).
-- ============================================================

-- ============================================================
-- PART 1 — items: measurement link + wastage + coverage
--
-- Mirrors cost_lines' existing measurement_id/wastage_pct pattern
-- (007_estimating.sql's measurements table + migration 009's
-- cost_lines.measurement_id/wastage_pct — see lib/estimate.ts
-- effectiveQty()) so a spec-register item's quantity can ALSO be
-- derived from a linked measurement instead of hand-typed, the same
-- UX already proven for estimate cost lines. See lib/item-quantity.ts
-- derivedQuantity() for the read-side formula this feeds.
--
-- coverage_per_unit is the one addition beyond cost_lines' shape:
-- cost lines only ever need a linear/area *quantity* (qty × rate), but
-- an item is often a per-box/per-unit product bought to cover an area
-- (e.g. a box of tiles covers 1.44 m² per box) — coverage_per_unit
-- lets derivedQuantity() convert "area needed" into "units/boxes to
-- buy" via a ceiling division. Nullable: most items don't need it
-- (a linked measurement with no coverage_per_unit just yields the
-- wastage-adjusted measurement value itself, e.g. for a linear-metre
-- skirting item).
-- ============================================================

alter table items
  add column if not exists measurement_id uuid
    references measurements(id) on delete set null;

comment on column items.measurement_id is
  'Round B (6 July 2026): optional link to a measurements row (same
  table cost_lines.measurement_id already links to). When set, the
  item''s quantity is DERIVED (see lib/item-quantity.ts
  derivedQuantity()) from that measurement''s value + wastage_pct,
  rather than hand-typed into items.quantity. items.quantity itself is
  left alone by a link (same "unlink reverts to whatever was last
  hand-entered" behaviour as cost_lines) — the API only overwrites
  quantity server-side when a PATCH explicitly includes it. ON DELETE
  SET NULL: a deleted measurement silently unlinks rather than
  blocking the delete or orphaning a dangling FK.';

alter table items
  add column if not exists wastage_pct numeric(5,2)
    check (wastage_pct is null or (wastage_pct >= 0 and wastage_pct <= 50));

comment on column items.wastage_pct is
  'Round B: percentage allowance added on top of a linked measurement''s
  value before coverage conversion, e.g. 10 = +10%. Same 0-50 bound and
  meaning as cost_lines.wastage_pct (migration 009) — only meaningful
  when measurement_id is set; the API/UI clear it back to null on
  unlink, same convention as the estimate module''s
  MeasurementLinkPicker onSelect(null) handler.';

alter table items
  add column if not exists coverage_per_unit numeric(10,4);

comment on column items.coverage_per_unit is
  'Round B: how much of the linked measurement''s unit ONE unit of this
  item covers, e.g. 1.4400 (m² per box of tiles) or 2.5000 (linear
  metres per length of skirting bought in fixed lengths). When set,
  derivedQuantity() = ceil(wastage-adjusted measurement value /
  coverage_per_unit) — "boxes/lengths to buy" rather than a raw area/
  length figure. Null (the common case) means the derived quantity is
  used as-is with no unit conversion (e.g. the item IS sold by the
  linked measurement''s own unit, like a paint job priced per m²).';

-- ============================================================
-- PART 2 — materials: a lightweight, reusable price list for the
-- Calculators feature (Phillip''s ideas list item 4). Deliberately NOT
-- the same table as library_items — a "material" here is a bulk/
-- commodity product (timber, plasterboard sheets, screws, adhesive)
-- bought by length/sheet/box and consumed by a calculator's bin-pack
-- or area math, not a discrete spec-register product with dimensions/
-- colour/finish/images. Keeping it a separate, minimal table avoids
-- dragging the calculators feature into the full items/library_items
-- schema (scrape state, client-approval flags, Monday sync, etc.) that
-- makes no sense for "a box of 75mm bugle screws".
-- ============================================================

create table if not exists materials (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  product_url        text,
  -- Sale unit — free text (not an enum: "ea", "sheet", "length", "box",
  -- "m2" are all real values calculators use; a fixed check-in list
  -- would need a migration every time a new material type is added).
  unit               text not null default 'ea',
  price              numeric(10,2),
  -- Last time `price` was set via the scraper (POST
  -- /api/materials/[id]/refresh-price) rather than hand-entered — lets
  -- the UI show "Refreshed 3 days ago" / flag a stale price. Left null
  -- for a hand-entered price that's never been through refresh.
  price_refreshed_at timestamptz,
  coverage_per_unit  numeric(10,4),
  notes              text,
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index if not exists idx_items_measurement on items(measurement_id);

create index if not exists idx_materials_deleted_at on materials(deleted_at);
create index if not exists idx_materials_name on materials(name);

drop trigger if exists trg_materials_updated_at on materials;
create trigger trg_materials_updated_at
  before update on materials
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — same Phase 1 shape as every other table in this
-- codebase: authenticated team gets a single permissive policy; real
-- enforcement of anything financial (materials.price here) is at the
-- API layer, same as items.price_trade already is (see
-- app/api/materials/route.ts's admin-gating on write/refresh, mirroring
-- app/api/items/[id]/route.ts's FINANCIAL_FIELDS pattern).
-- ============================================================
alter table materials enable row level security;

drop policy if exists "team_all" on materials;
create policy "team_all" on materials
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
