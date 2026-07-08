-- ============================================================
-- RESLU Spec System — Website lead intake (8 July 2026).
-- RESLU-Spec-Lead-Intake.md (Website handoff): the new reslu.com.au
-- /begin form POSTs enquiries to POST /api/leads/intake (bearer-
-- secret authenticated, see that route). This migration gives the
-- leads table somewhere to put the intake payload:
--
--   PART 1 — 'WEBSITE' joins the leads.source CHECK (META/DIRECT were
--   the only values migration 014 knew about; website enquiries are a
--   third, distinct acquisition channel).
--
--   PART 2 — verbatim intake fields on leads. MUST-KEEP per the spec:
--   gclid + the four utm_* columns power Aria's offline conversion
--   import (matching a booked studio visit back to the ad click) — if
--   these are dropped, Google Ads can never learn which clicks become
--   consultations. project_type/message/page complete the payload so
--   nothing the form sends is thrown away.
--
--   PART 3 — lead_attachments: the /begin form accepts up to 3 photos
--   (base64 JPEG, compressed client-side); the intake route stores the
--   bytes in the private 'assets' Storage bucket (same bucket + signed-
--   URL discipline as site_photos/invoices — lib/storage.ts) and one
--   row here per photo. Generic shape (not "lead_photos") so future
--   attachments (plans, briefs) can reuse it.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - RLS: single permissive "team_all" policy (admin gating for leads
--     is a whole-route 403 in app/api/leads/** — house style since 014)
--   - idempotent throughout (add column if not exists / create table
--     if not exists / drop-then-recreate constraint & policies) so a
--     partial apply converges on re-run
-- ============================================================

-- ============================================================
-- PART 1 — 'WEBSITE' source. Drop-then-add so re-runs converge (the
-- inline CHECK from 014 got the default name leads_source_check).
-- ============================================================
alter table leads drop constraint if exists leads_source_check;
alter table leads add constraint leads_source_check
  check (source in ('META', 'DIRECT', 'WEBSITE'));

-- ============================================================
-- PART 2 — verbatim intake fields. All nullable text — existing rows
-- are untouched; only the intake route (and future edits) write them.
-- No length constraints at the DB layer: the intake route clamps
-- lengths defensively (same division of labour as every other leads
-- column — 014 put no length checks on email/phone/location either).
-- ============================================================
alter table leads add column if not exists project_type text;
alter table leads add column if not exists message      text;
alter table leads add column if not exists page         text;
alter table leads add column if not exists gclid        text;
alter table leads add column if not exists utm_source   text;
alter table leads add column if not exists utm_medium   text;
alter table leads add column if not exists utm_campaign text;
alter table leads add column if not exists utm_content  text;

comment on column leads.gclid is
  'Google Ads click id, passed through verbatim from the website /begin form (POST /api/leads/intake). MUST-KEEP: Aria''s offline conversion import matches booked studio visits back to the ad click via this value — see RESLU-Spec-Lead-Intake.md.';

-- Aria's export/monitor queries filter on "website leads with a gclid"
-- — partial index keeps that cheap without indexing the (mostly-null)
-- column across the whole table.
create index if not exists idx_leads_gclid on leads(gclid) where gclid is not null;

-- ============================================================
-- PART 3 — lead_attachments. storage_path points into the private
-- 'assets' bucket (lib/storage.ts ASSET_BUCKET); consumers mint
-- short-TTL signed URLs per request, never public URLs — identical
-- discipline to site_photos (031)/invoices (009).
-- ============================================================
create table if not exists lead_attachments (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references leads(id) on delete cascade,
  filename      text not null,
  storage_path  text not null,
  mime          text,
  size_bytes    integer,
  -- 'intake' for photos arriving via POST /api/leads/intake; future
  -- uploads from the UI can use other values without a schema change.
  source        text not null default 'intake',
  created_at    timestamptz not null default now()
);

create index if not exists idx_lead_attachments_lead on lead_attachments(lead_id);

alter table lead_attachments enable row level security;

drop policy if exists "team_all" on lead_attachments;
create policy "team_all" on lead_attachments
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
