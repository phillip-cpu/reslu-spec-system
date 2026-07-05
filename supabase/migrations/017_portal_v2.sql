-- ============================================================
-- RESLU Spec System — Phase 11B: Portal v2, diary, site gallery,
-- decision deadlines, handover pack.
-- BUILD-SPEC.md §"Phase 11 — Client portal v2 + trade confirmations"
-- points 2-5, §"Phase 11 addition — site photo gallery", §"Phase 11
-- additions — confirmed by Phillip".
--
-- File-boundary note: this agent owns supabase/migrations/016_portal_v2.sql,
-- app/portal/** (excluding any /trade path), app/api/portal/**,
-- components/portal/** (excluding TimelineSection.tsx, which the Phase
-- 11A agent owns), app/(dashboard)/projects/[id]/client/**,
-- app/(dashboard)/projects/[id]/gallery/**, components/client-area/**,
-- components/gallery/**, lib/notify-client.ts, lib/simple-markdown.tsx,
-- app/api/projects/[id]/site-photos/**, app/api/site-photos/[id]/**,
-- app/api/projects/[id]/handover/**. Migration 015 (trade_visits /
-- schedule_phases kind/umbrella columns), components/gantt/**,
-- lib/gantt.ts, app/trade/**, app/api/trade/**, app/api/visits/** are
-- the Phase 11A agent's — NOT touched here, and this migration does
-- not assume 015 has landed (queries against trade_visits elsewhere in
-- the app code are written defensively, selecting only phase names/
-- dates and tolerating the table not existing yet).
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per new team-facing
--     table (Phase 1 — "no unenforced role theatre")
--   - soft delete via nullable deleted_at where the spec calls for it
--   - extending a CHECK constraint requires drop + re-add (Postgres
--     has no ALTER TABLE ... ALTER CONSTRAINT for check clauses) — done
--     explicitly below for project_files.kind and item_files.kind
-- ============================================================

-- ============================================================
-- PART 1 — site_photos (internal staging gallery)
-- BUILD-SPEC.md §"Phase 11 addition — site photo gallery": "site_photos
-- (id, project_id, storage_path, caption, taken_at date default today,
-- uploaded_by, published_to_portal boolean default false, created_at,
-- deleted_at) — private bucket, signed URLs."
--
-- Distinct from progress_photos (012_portal_expansion.sql), which
-- becomes the CURATED/PUBLISHED view per the spec: "Existing Week 8
-- portal progress-photos section becomes the published view of this
-- gallery ... one photo pipeline, staged internally, curated out."
-- Rather than migrating progress_photos data (out of scope — no data
-- migration tooling in this sandbox, and the spec describes a
-- behavioural change, not a table rename), the portal's progress-
-- photos section is repointed in this release to read from
-- site_photos where published_to_portal = true OR referenced by a
-- published portal_update (see PART 2's join table and the portal page
-- query) — progress_photos itself is left in place, untouched, for
-- backward compatibility with any historical rows, but is no longer
-- written to by new upload flows (the Gallery tab writes to
-- site_photos exclusively).
-- ============================================================
create table if not exists site_photos (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects(id) on delete cascade,
  storage_path          text not null,
  caption               text,
  taken_at              date not null default current_date,
  uploaded_by           uuid references profiles(id) on delete set null,
  published_to_portal   boolean not null default false,
  -- Phase 11 addition — handover pack: curated inclusion flag, ticked
  -- internally, independent of published_to_portal (a photo can be in
  -- the day-to-day published gallery without being one of the small
  -- curated set for the completion handover pack, and vice versa).
  in_handover_pack       boolean not null default false,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

create index if not exists idx_site_photos_project on site_photos(project_id, taken_at desc);
create index if not exists idx_site_photos_deleted_at on site_photos(deleted_at);
create index if not exists idx_site_photos_published on site_photos(project_id) where published_to_portal;

-- No updated_at trigger — mirrors progress_photos/item_files: uploads
-- are write-once (caption edits are a small PATCH, same pattern as
-- progress_photos' existing caption-only edit route).

alter table site_photos enable row level security;

drop policy if exists "team_all" on site_photos;
create policy "team_all" on site_photos  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 2 — portal_update_photos (join: diary entry <-> gallery photos)
-- BUILD-SPEC.md §"Phase 11 — Diary" / §"site photo gallery": "Diary
-- composer ... picks its 1-2 images FROM this gallery (join table
-- portal_update_photos: update_id, site_photo_id); publishing the
-- diary entry marks those photos published."
-- ============================================================
create table if not exists portal_update_photos (
  update_id       uuid not null references portal_updates(id) on delete cascade,
  site_photo_id   uuid not null references site_photos(id) on delete cascade,
  sort            integer not null default 0,
  created_at      timestamptz not null default now(),
  primary key (update_id, site_photo_id)
);

create index if not exists idx_portal_update_photos_photo on portal_update_photos(site_photo_id);

alter table portal_update_photos enable row level security;

drop policy if exists "team_all" on portal_update_photos;
create policy "team_all" on portal_update_photos  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 3 — portal_updates gains draft_source + status, migrating the
-- existing published_at semantics.
-- BUILD-SPEC.md §"Diary": "portal_updates gains draft_source
-- ('manual'|'aria') + status ('draft','pending_approval','published')
-- migrating the existing published_at semantics (published_at stays,
-- status derived for existing rows)."
--
-- published_at stays as the single source of truth for "is this
-- visible on the portal feed" (every existing query — the portal
-- page's `.not("published_at", "is", null)` filter — keeps working
-- unchanged, no code elsewhere needs to learn about `status` to stay
-- correct). `status` is an additional, richer field for the team-side
-- draft/approval UI so the diary workflow can distinguish "not yet
-- sent to Aria" / "drafted, awaiting Phillip's one-tap publish" /
-- "live" without overloading published_at's null-ness to mean two
-- different things.
-- ============================================================
alter table portal_updates
  add column if not exists draft_source text not null default 'manual'
    check (draft_source in ('manual', 'aria')),
  add column if not exists status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'published'));

-- Backfill status for existing rows from published_at, per the spec's
-- explicit instruction ("status derived for existing rows"). Anything
-- already published gets status='published'; anything still a draft
-- stays 'draft' (the column default), since there is no way to tell
-- from historical data alone whether a never-published row ever passed
-- through an aria pending_approval stage.
update portal_updates
set status = 'published'
where published_at is not null and status = 'draft';

create index if not exists idx_portal_updates_status on portal_updates(project_id, status);

-- ============================================================
-- PART 4 — Decision deadlines (design-phase framing)
-- BUILD-SPEC.md §"Phase 11 additions — confirmed by Phillip" point 2:
-- "approval requests gain decision_needed_by date" — items is the
-- approvable subject in this codebase (there is no separate
-- "approval_requests" table; item.client_approved/client_flagged +
-- approval_events IS the approval-request mechanism per BUILD-SPEC.md
-- §7), so decision_needed_by lands on items, per-item (not
-- project-level) — matching "Selections (FF&E approvals)" being a
-- per-item review flow (bulk approve, one-by-one stepper) where
-- different rooms/items can plausibly have different design-package
-- deadlines.
-- ============================================================
alter table items
  add column if not exists decision_needed_by date;

create index if not exists idx_items_decision_needed_by on items(project_id, decision_needed_by)
  where decision_needed_by is not null and client_approved = false;

-- ============================================================
-- PART 5 — project_files.kind gains 'certificate'
-- BUILD-SPEC.md §"Handover pack": "compliance certificates
-- (project_files kind addition 'certificate')".
-- Extending a CHECK constraint requires drop + re-add — Postgres has
-- no ALTER TABLE ... ALTER CONSTRAINT for check clauses.
-- ============================================================
alter table project_files
  drop constraint if exists project_files_kind_check;

alter table project_files
  add constraint project_files_kind_check
    check (kind in ('plans', 'council', 'engineering', 'scope_of_works', 'other', 'certificate'));

-- ============================================================
-- PART 6 — item_files.kind gains 'warranty'
-- BUILD-SPEC.md §"Handover pack": "manuals & warranties (item_files of
-- kind install_manual + new kind 'warranty')".
-- item_files' original check constraint was defined inline in
-- 001_initial.sql without an explicit name, so Postgres auto-named it
-- "item_files_kind_check" (the default naming convention:
-- <table>_<column>_check) — verified against 001_initial.sql's
-- `kind text not null check (kind in (...))` column definition, which
-- is the same inline-check shape project_files uses in
-- 008_project_files.sql (whose auto-name is confirmed working via the
-- drop above), so the same naming convention applies here.
-- ============================================================
alter table item_files
  drop constraint if exists item_files_kind_check;

alter table item_files
  add constraint item_files_kind_check
    check (kind in ('spec_sheet', 'install_manual', 'other', 'warranty'));

-- item_files also gains in_handover_pack, for the same curated-handover
-- reason as site_photos above.
alter table item_files
  add column if not exists in_handover_pack boolean not null default false;

-- project_files gains in_handover_pack too (curated documents in the
-- handover section — "final documents" per the spec).
alter table project_files
  add column if not exists in_handover_pack boolean not null default false;

-- ============================================================
-- PART 7 — projects gains client_email + notify_client
-- BUILD-SPEC.md §"Phase 11 additions — confirmed by Phillip" point 1:
-- "email to client (project client_email — add field if missing) ...
-- Per-project toggle in settings" -> notify_client boolean.
-- ============================================================
alter table projects
  add column if not exists client_email text,
  add column if not exists notify_client boolean not null default true;

-- ============================================================
-- Notes on things intentionally NOT added here:
--
-- - No separate "approval_requests" table — decision_needed_by lives
--   on items directly (PART 4), consistent with how approvals already
--   work in this codebase (booleans + approval_events, no separate
--   request row).
-- - trade_visits, schedule_phases.kind/cost_section_id are the Phase
--   11A agent's migration 015 — not referenced by name in any DDL
--   here. Application code that queries schedule_phases for the
--   "what's next" block selects only id/name/start_date/end_date
--   (columns that exist since 013_boards_contacts.sql) and is written
--   to tolerate trade_visits not existing / erroring gracefully.
-- ============================================================
