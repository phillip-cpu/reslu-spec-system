-- ============================================================
-- RESLU Spec System — Week 7: fix the missing `assets` bucket,
-- measurement ↔ estimate line linking (+ wastage), project cover images.
--
-- ------------------------------------------------------------
-- PART 1 — the `assets` Storage bucket (user-reported bug, highest
-- priority)
--
-- Diagnosis (confirmed by reading lib/storage.ts + every call site):
-- lib/storage.ts exports ASSET_BUCKET = "assets" and every upload route
-- for item files (spec sheets/install manuals), the "attach from URL"
-- scraper-detected-document flow, project documents, and invoice PDFs
-- uploads into that bucket — but NO migration ever created it. Only
-- `item-images` exists as a bucket (007_estimating.sql), created for an
-- unrelated purpose (the PDF pre-pass re-hosting flow, lib/images.ts).
-- README.md's "Deploying to Vercel" section even flags this by hand
-- ("assets must still be created by hand") — this migration removes
-- that manual step and makes a fresh Supabase project work out of the
-- box. In production this surfaces as: "spec sheet attach fails" (the
-- user-reported bug), and would equally break project document
-- uploads and invoice PDF uploads, which share the same bucket.
--
-- Public vs private decision:
-- Every current CONSUMER of the `assets` bucket reads via a route that
-- mints a fresh URL server-side per request:
--   - GET /api/items/[id]/files            → (was) getPublicUrl
--   - GET /api/projects/[id]/files         → (was) getPublicUrl
--   - app/portal/[token]/page.tsx          → createSignedUrl (already)
--   - Invoices (app/api/projects/[id]/invoices/**) → no read route
--     exists yet; the PDF is only ever written, never served back out
--     via a public link
-- None of these persist the minted URL anywhere long-lived — a fresh
-- URL is generated on every GET. That makes `assets` a good fit for a
-- PRIVATE bucket + short-TTL signed URLs everywhere (this migration's
-- companion code change switches the two getPublicUrl call sites above
-- to createSignedUrl, matching the portal page's existing pattern).
-- Client documents/invoices are exactly the kind of thing that
-- shouldn't be reachable by anyone who merely guesses/finds a storage
-- URL — signed URLs are the correct default here.
--
-- The ONE exception is item cover images
-- (app/api/items/[id]/image/route.ts): that route's returned URL gets
-- PERSISTED onto items.selected_image_url and reused indefinitely —
-- rendered directly by next/image in the spec register, the client
-- portal, and embedded into the builder PDF (components/pdf/SchedulePdf.tsx
-- via lib/images.ts's ensureStoredImage). A short-TTL signed URL would
-- go stale and break every one of those surfaces after expiry. The
-- existing PDF pre-pass (lib/images.ts) already established the
-- correct home for this kind of durable, publicly-embeddable image:
-- the `item-images` bucket (public=true, created in
-- 007_estimating.sql). This migration's companion code change moves
-- app/api/items/[id]/image/route.ts's upload+URL-mint onto that same
-- bucket, so item cover images have exactly one home instead of being
-- split across two buckets depending which code path wrote them last.
--
-- Net decision: `assets` = PRIVATE, signed URLs, for item files
-- (spec_sheet/install_manual/other), project documents, and invoice
-- PDFs. `item-images` = PUBLIC (unchanged), for item cover images only
-- (both the manual "Replace image" upload and the PDF pre-pass
-- re-hosting copy) — semantically it's already named for this and
-- 007_estimating.sql already documented public read as an accepted
-- trust model for "already-selected product images, not sensitive".
--
-- Existing-data implication (documented for on-machine verification,
-- since this agent cannot run the app against a live Supabase project):
-- if any environment already has real data with a genuinely public
-- `assets` bucket manually created as a workaround for this bug, its
-- item_files/project_files storage_path values are unaffected by this
-- migration (bucket visibility toggling doesn't move objects), but any
-- UI/PDF that stored a **public** `assets` URL directly (rather than
-- storage_path + mint-on-read) would need those cached URLs
-- regenerated. Grep confirms no such caching exists in this codebase —
-- every consumer stores storage_path and mints the URL fresh on each
-- read — so flipping this bucket to private is safe with today's code.
-- The one place a URL IS persisted (items.selected_image_url) already
-- only ever gets a URL from `item-images` (public) after this
-- migration's companion code change, so it is unaffected too. If a
-- production project has old rows where selected_image_url points at
-- `.../object/public/assets/items/...` (written before this fix, back
-- when the image route also used `assets` + getPublicUrl), those rows
-- will 403 once `assets` goes private — see README.md's Troubleshooting
-- section (updated alongside this migration) for the one-time backfill
-- note: re-upload the image (or run a small script that copies the
-- object from assets/ to item-images/ and updates the column) for any
-- item whose selected_image_url still points at the old bucket.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- PART 2 — Estimate ↔ Schedule: measurement-linked cost lines + wastage
-- BUILD-SPEC.md "Estimate ↔ Schedule integration": a cost line's
-- quantity can be driven by a measurement (e.g. "Tiling — Ensuite floor"
-- measured in m2) plus a wastage allowance, instead of being hand-typed.
-- When linked, effectiveQty = measurement.value * (1 + wastage_pct/100)
-- — see lib/estimate.ts effectiveQty(). qty stays as a plain column
-- (unlinked lines still hand-enter it exactly as before); wastage_pct
-- only makes sense in the context of a linked measurement so it's
-- nullable and only read/displayed when measurement_id is set.
-- ------------------------------------------------------------
alter table cost_lines
  add column if not exists measurement_id uuid references measurements(id) on delete set null,
  add column if not exists wastage_pct numeric(5,2);

create index if not exists idx_cost_lines_measurement on cost_lines(measurement_id);

-- Constrain wastage_pct to a sane 0–50% range at the DB layer too (the
-- API additionally validates this — see app/api/estimate/lines/[id]/route.ts
-- — but a check constraint means the range holds even for a future
-- direct-SQL write).
alter table cost_lines
  drop constraint if exists cost_lines_wastage_pct_range;
alter table cost_lines
  add constraint cost_lines_wastage_pct_range
  check (wastage_pct is null or (wastage_pct >= 0 and wastage_pct <= 50));

-- ------------------------------------------------------------
-- PART 3 — Project cover images
-- BUILD-SPEC.md "Project cover image": dashboard project cards and the
-- project page header show a thumbnail. Stored in the same private
-- `assets` bucket as every other client-confidential file (client
-- houses are private, unlike item product photos — see the bucket
-- decision above), path projects/{id}/cover.<ext>, served via
-- server-minted signed URLs (see app/api/projects/[id]/cover/route.ts).
-- ------------------------------------------------------------
alter table projects
  add column if not exists cover_image_path text;
