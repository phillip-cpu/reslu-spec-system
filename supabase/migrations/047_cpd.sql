-- ============================================================
-- RESLU Spec System — CPD point tracker.
-- BUILD-SPEC.md "CPD point tracker" section. That section's own
-- placeholders (exact annual target number, licence-year start month,
-- CBS category split) were never resolved — this migration + its
-- accompanying API/UI ship with sensible, ADMIN-EDITABLE defaults
-- instead of guessing a real regulatory figure:
--   - annual_target defaults to 12 points
--   - year_start_month defaults to 7 (July) — an Australian financial-
--     year-style licence year, not calendar-year
--   - category is FREE TEXT with UI datalist suggestions ("Technical",
--     "Business", "Compliance", "Safety") — no CHECK/enum constraint,
--     since the real CBS category split was never specified and a
--     free-text column can be tightened to an enum later without a
--     data migration, whereas the reverse (enum -> free text after
--     real rows exist) is the more painful direction.
-- Both numeric defaults live in app_settings key 'cpd_defaults' (NO
-- new column/table for them — same "generic key/value settings store"
-- convention as invoice_bank_details/export_presets/phase_template,
-- see lib/cpd.ts's FALLBACK_CPD_DEFAULTS for the code-level fallback
-- used until an admin first saves this key). Per-user override
-- profiles-side (e.g. a part-time team member with a lower personal
-- target) is EXPLICITLY SKIPPED in this v1 — one studio-wide target/
-- year-start for everyone — see lib/cpd.ts's header comment for the
-- extension point a future round would need (a nullable per-profile
-- override column, falling back to this same app_settings row).
--
-- Conventions carried over from every prior migration:
--   - uuid pk via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style) — except
--     `category` below, which is deliberately free text with NO CHECK
--     at all (see above)
--   - idempotent throughout (create table if not exists / drop+recreate
--     policy) so a partial apply converges cleanly on re-run
--   - RLS: single permissive "team_all" policy at the DB layer (Phase 1
--     house style) — the API layer is the real gate: every route
--     scopes WRITES (POST/PATCH/DELETE) to the caller's own user_id
--     unless the caller is an admin, who may act on any user's row
--     (needed for the add_cpd_entry MCP tool, which attributes an
--     entry to a resolved user_id on behalf of Aria's admin account —
--     see app/api/cpd/route.ts's POST doc comment). Admins may also
--     VIEW every team member's entries (GET ?all=1) — CPD records are
--     not financial data, so this is a lighter gate than the
--     client_invoices/bank-details admin-only-everything shape; a
--     non-admin team member can only ever see/edit their OWN entries.
--
-- File-boundary note: owned entirely by this task (CPD tracker). Does
-- not touch client_invoices/bank_details (migration 046, invoicing
-- round) or any Second Brain table (migrations 033-045). Only new
-- object created here is `cpd_entries`.
-- ============================================================

create table if not exists cpd_entries (
  id                 uuid primary key default gen_random_uuid(),

  user_id            uuid not null references profiles(id),

  activity_title     text not null,
  provider           text,
  activity_date      date not null,

  -- numeric(5,2): supports fractional points (e.g. a 1.5-hour webinar)
  -- up to 999.99 — comfortably beyond any plausible single-activity
  -- point value. Must be strictly positive; a zero-point "activity" has
  -- nothing to log.
  points             numeric(5,2) not null check (points > 0),

  -- Free text, NOT a CHECK enum — see header comment. The CPD page's
  -- add form suggests 'Technical' / 'Business' / 'Compliance' / 'Safety'
  -- via an HTML <datalist> (client-side only, no DB constraint), so a
  -- team member can still type anything the real CBS category list
  -- eventually turns out to need without a migration.
  category           text,

  -- Optional supporting evidence (certificate, confirmation email PDF,
  -- webinar screenshot) — same private-bucket signed-URL pattern as
  -- contact_documents (migration 013) / project_files, stored directly
  -- on this row rather than a child table since a CPD entry has at most
  -- ONE evidence file (unlike contact_documents' one-to-many).
  evidence_path      text,
  evidence_filename  text,

  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

comment on table cpd_entries is
  'RESLU Spec System — CPD point tracker (migration 047). One row per logged CPD activity (webinar, course, conference, etc.), owned by user_id. Team-visible read via RLS (team_all, permissive), but every API route scopes WRITES to the caller''s own user_id unless the caller is an admin (may write/view any user''s rows) — see app/api/cpd/**''s doc comments. Annual target + licence-year start month live in app_settings(''cpd_defaults''), not on this table — see lib/cpd.ts.';

comment on column cpd_entries.points is
  'Strictly positive, up to 2 decimal places (numeric(5,2)) — supports fractional CPD hours/points (e.g. 1.5 for a 90-minute webinar).';

comment on column cpd_entries.category is
  'Free text, no CHECK constraint — BUILD-SPEC.md''s CBS category split was never resolved to a fixed list. UI offers a datalist of suggestions (Technical/Business/Compliance/Safety) but accepts anything.';

comment on column cpd_entries.evidence_path is
  'Storage object key in the private `assets` bucket (see lib/storage.ts ASSET_BUCKET), prefixed cpd/{user_id}/... At most one evidence file per entry — re-uploading replaces it (old object removed by the API, see PATCH /api/cpd/[id]).';

-- Trigger-free updated_at: reuse the shared set_updated_at() trigger
-- function (001_initial.sql), same as every other table in this
-- codebase — not a second convention.
drop trigger if exists trg_cpd_entries_updated_at on cpd_entries;
create trigger trg_cpd_entries_updated_at
  before update on cpd_entries
  for each row execute function set_updated_at();

-- Primary query shape: "this user's entries within the current CPD
-- year window, most recent first" (both the CPD page's own list and
-- the My Work pro-rata nudge's points-to-date sum) — see
-- lib/cpd.ts computeCpdYearWindow().
create index if not exists idx_cpd_entries_user_date
  on cpd_entries(user_id, activity_date)
  where deleted_at is null;

alter table cpd_entries enable row level security;

drop policy if exists "team_all" on cpd_entries;
create policy "team_all" on cpd_entries
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
