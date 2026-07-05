-- ============================================================
-- RESLU Spec System — Phase 12a-A: Estimate versioning + VM,
-- SOW clause templates (schema hook only — the library itself lives in
-- lib/sow-templates.ts, a TS module, not DB rows), Aria plan analysis +
-- takeoff assist.
-- BUILD-SPEC.md "Phase 12a — My Work + estimate versioning with VM"
-- (versioning half only — My Work/user_notes is Phase 12a-B's file),
-- "SOW completion + Aria plan analysis", "Aria takeoff assist".
--
-- Conventions carried over from prior migrations (007/008/011/015):
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper reused, not redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1: no
--     unenforced role theatre at the RLS layer — real enforcement for
--     financial surfaces, like estimate_versions, is the API-layer
--     admin check, exactly like cost_lines/variations/measurements in
--     007_estimating.sql)
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate triggers & policies) so a partial
--     apply converges cleanly on re-run
-- ============================================================

-- ============================================================
-- PART 1 — Estimate versioning + VM (Value Management)
-- BUILD-SPEC.md: "estimate_versions (id, project_id, label e.g. 'V1' |
-- 'VM_V2', kind ('issue'|'vm'), snapshot jsonb — full frozen estimate:
-- sections, lines, FF&E rollup, totals, linked SOW revision label,
-- created_by, created_at, note)."
--
-- The snapshot is a single jsonb blob rather than normalised
-- versioned-sections/lines tables — a version is a frozen, immutable
-- READ artefact (the comparison view and read-only viewer only ever
-- render it, never edit it in place), so there is no benefit to
-- relational structure here and real cost to it (a schema change to
-- cost_lines would otherwise force a parallel migration of historical
-- version rows). This mirrors items.scraped_documents /
-- projects.document_status's existing "jsonb for a frozen/loosely-typed
-- blob, relational for anything live-editable" split in this codebase.
-- ============================================================
create table if not exists estimate_versions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  -- e.g. "V1", "V2", "VM_V2" — free text, team-chosen, not auto-numbered
  -- (unlike variations.var_number) since VM labels follow the
  -- business's own "V1 / VM_V2" convention rather than a strict
  -- sequence — see lib/estimate-versions.ts suggestNextLabel() for a
  -- non-binding suggestion only.
  label        text not null,
  kind         text not null default 'issue' check (kind in ('issue', 'vm')),
  -- Full frozen snapshot — see lib/estimate-versions.ts EstimateSnapshot
  -- for the documented shape (sections/lines, ffe rollup, wholeJob
  -- totals, markup_pct, linked SOW revision label, measurements).
  snapshot     jsonb not null,
  note         text,
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- label unique per project (versions are never soft-deleted — a frozen
-- historical snapshot is kept indefinitely per the build spec's "VM
-- comparison view" needing to reference any past version at any time;
-- no deleted_at column on this table on purpose).
create unique index if not exists idx_estimate_versions_project_label
  on estimate_versions(project_id, label);

create index if not exists idx_estimate_versions_project
  on estimate_versions(project_id, created_at desc);

drop trigger if exists trg_estimate_versions_updated_at on estimate_versions;
create trigger trg_estimate_versions_updated_at
  before update on estimate_versions
  for each row execute function set_updated_at();

-- ============================================================
-- PART 2 — Aria plan analysis
-- BUILD-SPEC.md "SOW completion + Aria plan analysis": "plan_analyses
-- table: project_id, file_id, revision_label, rooms jsonb (room names
-- found on plans), item_codes jsonb (codes found), discrepancies jsonb,
-- analysed_at, analysed_by."
--
-- file_id references project_files (kind 'plans') — cascade delete so
-- an analysis record never outlives the plan file it was run against.
-- ============================================================
create table if not exists plan_analyses (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  file_id          uuid not null references project_files(id) on delete cascade,
  revision_label   text,
  -- Room names Aria found annotated on the plan set, e.g.
  -- ["Main Bathroom", "Ensuite", "Powder Room"]. Plain jsonb string
  -- array — see lib/takeoff.ts PlanAnalysisRoom for the richer shape
  -- (rooms[] in the POST body also carries stated dimensions; this
  -- column stores just the room-name projection for the discrepancy
  -- engine + overview card, keeping the column itself simple/queryable
  -- while dimensions live in `dimensions` below for the takeoff step).
  rooms            jsonb not null default '[]',
  -- Item codes Aria found referenced on the plan set, e.g.
  -- ["SS-01", "SS-02", "TW-01"].
  item_codes       jsonb not null default '[]',
  -- Per-room stated dimensions as submitted by Aria, keyed by room name
  -- — see lib/takeoff.ts PlanAnalysisRoom. Kept separate from `rooms`
  -- so the simple room-name list stays a flat string array (the shape
  -- the cross-reference engine and overview card actually consume).
  dimensions       jsonb not null default '[]',
  -- Cross-reference engine output (lib/takeoff.ts crossReferencePlans())
  -- — see that function's return type for the full discrepancy shape:
  -- codes on plan missing from register, register items never placed
  -- on plan, rooms on plan with no FF&E items, register locations not
  -- matching plan room names.
  discrepancies    jsonb not null default '[]',
  analysed_at      timestamptz not null default now(),
  analysed_by      text,  -- free text ("Aria" or a profile display name) — analysis is submitted via API/MCP, not always a logged-in team session
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_plan_analyses_project on plan_analyses(project_id, analysed_at desc);
create index if not exists idx_plan_analyses_file on plan_analyses(file_id);

drop trigger if exists trg_plan_analyses_updated_at on plan_analyses;
create trigger trg_plan_analyses_updated_at
  before update on plan_analyses
  for each row execute function set_updated_at();

-- ============================================================
-- PART 3 — Aria takeoff assist: measurements gain status + source
-- BUILD-SPEC.md "Aria takeoff assist": "Measurements gain status
-- ('draft'|'verified') + source ('manual'|'takeoff') columns."
--
-- Existing measurements rows (007_estimating.sql, hand-entered before
-- this feature existed) all default to status 'verified' / source
-- 'manual' — they were entered by a human as a real, trusted figure,
-- not derived from an unverified plan annotation, so treating pre-
-- existing data as anything less than "verified" would incorrectly
-- flag the entire existing Areas & Measurements tab across every
-- live project as needing site-measure confirmation.
-- ============================================================
alter table measurements
  add column if not exists status text not null default 'verified'
    check (status in ('draft', 'verified'));

alter table measurements
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'takeoff'));

-- Provenance note shown alongside a draft measurement — BUILD-SPEC.md's
-- two exact phrasings: "derived from stated dimensions — verify" |
-- "no stated dimension — measure on site". Free text so the takeoff
-- writer (lib/takeoff.ts) can also note which room/plan revision it
-- came from; nullable since manually-entered measurements have no
-- provenance to record.
alter table measurements
  add column if not exists provenance_note text;

create index if not exists idx_measurements_status on measurements(project_id, status);

-- ============================================================
-- Row Level Security — same Phase 1 shape as every other table.
-- estimate_versions carries financial data (frozen cost lines/FF&E/
-- totals) — RLS stays the permissive team_all shape per this
-- codebase's established pattern (real enforcement is the API-layer
-- admin check in app/api/projects/[id]/versions/**, exactly like
-- cost_lines/variations/measurements before it), not a stricter RLS
-- policy that would be the only such exception in the schema.
-- ============================================================
alter table estimate_versions enable row level security;
alter table plan_analyses enable row level security;

drop policy if exists "team_all" on estimate_versions;
create policy "team_all" on estimate_versions
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on plan_analyses;
create policy "team_all" on plan_analyses
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
