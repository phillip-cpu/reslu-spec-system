# RESLU Spec System — API reference

This is the agent-integration contract for the RESLU Spec System's REST
API (`app/api/**`). BUILD-SPEC.md "Agent control — Aria" (Phase 1):
Aria authenticates as a normal Supabase user (`aria@reslu.com.au`,
email/password → JWT) and drives the product entirely through these
routes — every UI capability has (or should have) a route here. Routes
tagged **Aria-relevant** are the ones she's expected to call most:
items CRUD/import, invoices POST/PATCH/approve, estimate reads, leads
CRUD/stage-move/needs-attention.

Written by walking every file under `app/api/**` in this working copy
(Week 6), kept current through Week 10. If a route changes, update this
file in the same commit — this is now the **single, consolidated** API
doc; the two weekly "additions" files that previously existed
(`docs/API-portal-additions.md` for Week 8B, `docs/API-week9-additions.md`
for Week 9) have been folded in below (Week 8B's content lives under
"Portal expansion & native e-signature — Week 8B"; Week 9's lives under
"Address Book, Project board & Gantt — Week 9") and deleted from the
repo — do not recreate that per-week-file pattern going forward.

## Auth tiers used below

- **session** — any signed-in team member (`supabase.auth.getUser()`
  returns a user). No role check.
- **session (financial fields admin-only)** — signed in required; the
  route runs for any team member, but `price_trade` and related
  financial fields are stripped from the response (GET) or silently
  dropped from the request body (POST/PATCH) unless the caller is an
  `admin`. Non-financial data is still team-visible.
- **admin** — whole-route 403 for any non-admin before any query runs
  (the Estimate, Invoices, and category-management modules use this
  shape — see `lib/auth.ts` `getUserRole`/`isAdmin`).
- **portal-token** — no Supabase session at all; the token is a URL
  path segment validated against `projects.client_token` via a
  service-role client (bypasses RLS). No session cookie required or
  used. **Not available to Aria** — BUILD-SPEC.md "Safety rails":
  "approve/flag stays client-portal-only (not agent-invocable)."

Note: there is no `middleware.ts` in this codebase gating `/api/**` —
every route performs its own auth check in-handler. A route that omits
this check has no fallback net, so treat the checks below as the only
enforcement that exists.

---

## Projects

### GET /api/projects
Auth: session. Body: none. Response: `{ projects: ProjectWithCounts[] }`
(ordered `updated_at desc`; no archived filter applied — archived
projects are included). **Aria-relevant.**

### POST /api/projects
Auth: session. Body: `{ name, client_name, address?, monday_board_id?, budget?, job_number?, standard_item_ids? }`.
Response: `{ project }` (201) or `{ error }` (409 on a job_number
clash). `client_token` is DB-generated, never accepted from the
request. **Aria-relevant.**

**Standard spec items (migration `030_standards_lead_notes.sql`,
"Two from Phillip — 7 July 2026"):** `standard_item_ids?` — an array of
`library_items.id` (normally every id currently flagged `is_standard`,
pre-ticked by `components/projects/StandardItemsChecklist.tsx`, but any
subset the caller supplies is honoured). Each id is copied onto the new
project's spec register via `lib/library-items.ts`
`copyLibraryItemToProject()` — the SAME insert shape
`POST /api/projects/[id]/items` already builds for a single
`library_item_id`, extracted into a shared helper rather than
duplicated. Best-effort: an id that no longer exists is silently
skipped; nothing here can fail project creation itself. The identical
field/behaviour is also accepted by
`POST /api/leads/[id]/create-project` (see that route below).

**Job numbers (migration `028_job_numbers.sql`, "Three from Phillip —
6 July 2026 evening" item 2):** when `job_number` is omitted, one is
auto-generated (`lib/job-number.ts` `nextJobNumber()` — max of every
existing numeric `job_number` + 1, zero-padded to 3 digits, rolling to
4 naturally past 999) and a single retry covers the narrow race of two
concurrent creates computing the same "next" number. When supplied
explicitly, it's used as-is and a clash surfaces as a real 409 (no
silent reassignment). `POST /api/leads/[id]/create-project` (the
lead-to-project path) generates a number the exact same way — see that
route's own doc comment.

### GET /api/projects/[id]
Auth: session. Body: none. Response: `{ project }`. Not-found and any
DB error both surface as 404 `"Project not found"` (no 500 case is
distinguished here). **Aria-relevant.**

### PUT /api/projects/[id]
Auth: session. Body: `Partial<Project>` — only `id`, `client_token`,
`created_at`, `updated_at` are stripped; every other field (including
`status`) is accepted. Response: `{ project }`. Note: this means
`status: "archived"` can be set via PUT as an alternate path to the
dedicated DELETE below — both work, DELETE is the documented way.

**Phase 11 extension (5 July 2026):** `components/settings/
ProjectSettingsForm.tsx` gains a "Client contacts" group writing
through this same route (no new route needed — the body-passthrough
above already covers it): `client_email`, `notify_client` (both
migration `016_portal_v2.sql` — existed in the schema since Phase 11B
but were never surfaced on any form until now) plus `client_phone`,
`client_secondary_name`, `client_secondary_email`,
`client_secondary_phone` (new, migration `017_project_contacts.sql` —
second owner on a couple's job).

**Job numbers (migration `028_job_numbers.sql`, "Three from Phillip —
6 July 2026 evening" item 2):** unlike the general body-passthrough
above, `job_number` gets an explicit pre-check ahead of the update —
validated against `^\d{3,4}$` (400 if not), and checked for a clash
against another project's `job_number` (409, clear message) — mirroring
`PATCH /api/items/[id]`'s `item_code` clash-check pattern rather than
relying solely on the DB's partial unique index
(`idx_projects_job_number_active`). A raw Postgres `23505` from the
update itself (a narrow concurrent-write race the pre-check can't fully
close) also maps to 409 as a fallback. Empty string clears the field
back to `null` (project re-enters the auto-numbered pool — though
nothing re-assigns it automatically; a null `job_number` just means
"unnumbered" until someone sets one). Surfaced in
`components/settings/ProjectSettingsForm.tsx` as a "Job number" field
next to Alias.

### DELETE /api/projects/[id]
Auth: session. Body: none. Response: `{ ok: true }`. Soft-delete: sets
`status = "archived"` (not a hard delete).

### POST /api/projects/[id]/regenerate-token
Auth: **admin**. Body: none. Response: `{ token }` (200) or
`{ error }` (401/403/500). Regenerates `projects.client_token`
(32-byte hex). Shares its implementation with the `/projects/[id]/settings`
page's server action via `lib/projects.ts` `regenerateProjectToken()` —
added Week 6 to close an API-parity gap (this action previously had no
REST route). **Aria-relevant** (admin-scoped agent use only).

### GET /api/projects/[id]/pdf
Auth: session. Body: none. Query: `?revision=`, `?subtitle=`, `?nocache=1`
(Phase 14A — force a fresh render, bypassing the cache check below).
Response: raw PDF binary (`Content-Disposition: inline`,
`Cache-Control: no-store`, `X-Pdf-Cache: hit|miss` header — Phase 14A).
Uses an explicit `PDF_ITEM_FIELDS` whitelist that excludes all
pricing/ordering columns — the builder-facing PDF never contains
financial data regardless of caller role. Items filtered to
non-deleted, ordered category then item_code.

**Phase 14A caching:** before rendering, a cheap key query (max item
`updated_at` + active item count + `revision`/`subtitle`) is hashed
(SHA-256) and checked against a Storage object at
`assets/pdf-cache/{projectId}/{hash}.pdf`; a hit streams the cached
bytes back with no render/image-copy work at all. A miss renders as
before and best-effort writes the result to that path (via `after()`)
for next time. Render failures are now caught and logged to
`app_errors` (see "System health" below) instead of surfacing as an
unhandled crash.

**"Export + board batch" round (7 July 2026) additions:**

- `?categories=TW,SW` — multi-category filter, comma-separated category
  prefixes. Extends the previous single-value filter; the legacy
  singular `?category=TW` still works and is merged in alongside
  `?categories=` (both accepted, de-duped). Absent/empty means every
  category (the export dialog's "all ticked default = full schedule").
  Applied to both the item query (`.in("category", ...)`) and the
  cache key, so a category-filtered PDF and the full schedule never
  collide on one cached object.
- `?docs=1` — "Include item documents": when set, the response is a
  merged print bundle instead of the bare schedule — schedule pages
  first, then (in schedule order) each in-scope item's attached
  `spec_sheet`/`install_manual` PDFs, each preceded by a brand-styled
  separator page ("TW-01 — Melbourne Robe Hook — Spec sheet"). Built
  via `lib/pdf-bundle.ts` using `pdf-lib` for the byte-level page
  merge (schedule + separators + attached PDFs — see that module's own
  doc comment for why the separator page itself is rendered with
  React-PDF, not pdf-lib's low-level text API). Non-PDF attachments
  (images etc.) and any per-file fetch failure are listed on a trailing
  "Documents index" page ("not printable — view in app" /
  "could not be retrieved") rather than blocking the bundle — a
  bad/missing file never fails the whole download. Folded into the
  cache key too (a digest of the in-scope items' `item_files` rows —
  `kind`/`storage_path`/`uploaded_at`, since that table has no
  `updated_at` column) so attaching/removing a document invalidates
  the cached bundle.
- `?filename=` — optional filename override, used by the export dialog
  to send its own "{project} — {preset|Custom} schedule.pdf" hint
  instead of the route's generated `{Project}-FFE-Schedule.pdf` /
  `{Project}-FFE-Print-Bundle.pdf` default.

**Function timeout / bundle size caveat:** per-item document fetches
inside `buildDocBundle` are sequential (one bad file must never block
or fail the rest — same reasoning as the existing image pre-pass).
`vercel.json` (protected, not edited by this round) already sets this
route's `maxDuration: 60`; a project with an unusually large number of
attached PDF documents could exceed that purely on download+merge
time. See README.md's "PDF bundle size" note for the documented fix
(bump `maxDuration` for this route) — deliberately not applied here
since `vercel.json` is out of this round's edit boundary.

### GET /api/settings/export-presets
Auth: session (read; team-visible, same trust tier as
`/api/settings/phase-template`). Response: `{ presets: [{ name,
prefixes[], contact_categories? }] }`, read from
`app_settings('export_presets')`. Falls back to
`lib/export-presets.ts`'s `FALLBACK_EXPORT_PRESETS` (Plumber → TW+SW,
Electrician → LI+EL) when the row has never been written — no
migration in this round (`app_settings` carries the presets, per
BUILD-SPEC.md "Export + board batch" item 1). **"Trade booking
document pack" round (8 July 2026):** each preset row gained an
optional `contact_categories: string[]` field — free-text categories
(e.g. `["Plumber", "Plumbing"]`) this preset is understood to apply to,
matched case-insensitively/containment against a booking contact's own
`contacts.category` by `BookVisitPanel`'s Schedule auto-pick
(`lib/export-presets.ts`'s `pickPresetForContactCategory()`). Omitted
on any preset that never declares one — falls through to a
name-keyword heuristic, then "full schedule."

### PUT /api/settings/export-presets
Auth: admin only. Body: `{ presets: [{ name, prefixes[],
contact_categories? }] }` — full replace. Every row needs a non-empty
trimmed name and at least one category prefix (prefixes are upper-cased
and de-duped; `contact_categories`, if present, is trimmed/de-duped but
NOT upper-cased — it's a longer human label matched case-insensitively
at read time, not a fixed short code). Backs
`components/settings/ExportPresetSettings.tsx`, which now also renders
an "Applies to contact categories" free-text field per row.

### GET /api/projects/[id]/cover
Auth: session. Body: none. Response: `{ url: string | null }` — a
freshly-minted signed URL (1hr TTL) for the project's cover image, or
`null` if none is set. Used to refresh the URL client-side after it
expires (Week 7).

### POST /api/projects/[id]/cover
Auth: session. Body: multipart `{ file }` (`image/*`, 10MB cap).
Response: `{ cover_image_path, url }` (the freshly-minted signed URL, so
the caller can show the new cover immediately without a second fetch).
Uploads to the **private** `assets` bucket at the fixed path
`projects/{id}/cover.<ext>` (`upsert: true` — replacing a cover never
accumulates orphaned Storage objects). Client houses are private
information (unlike item product photos, which are already-public
supplier catalogue images), hence the private bucket — unlike item
images, which live in the public `item-images` bucket.

### DELETE /api/projects/[id]/cover
Auth: session. Body: none. Response: `{ ok: true }`. Removes the
Storage object (best-effort — proceeds even if the object is already
missing) and clears `projects.cover_image_path`.

### POST /api/projects/[id]/import
Auth: session. Body: `{ csv: string, mapping: Record<string, string | null> }`
(server re-parses the raw CSV; never trusts client-parsed rows).
Response: `{ created, skipped, errors, results: ImportRowResult[] }`
where each result is `{ row, item_code, name, status: "created"|"skipped_duplicate"|"error", reason? }`.
Duplicate detection via a preloaded set of active item_codes plus an
in-batch Set; a race caught as Postgres 23505 becomes
`skipped_duplicate`; an unknown category prefix (23503) becomes
`error`. Only writes spec-view fields — no pricing is ever imported.
**Aria-relevant.**

### GET /api/projects/[id]/items
Auth: session (spec-view only — see notes). Body: none. Query:
`?category=`, `?status=`, `?q=` (case-insensitive partial match across
name/item_code/supplier/brand). Response: `{ items }` via an explicit
`SPEC_VIEW_COLUMNS` list that excludes `price_rrp`, `price_trade`,
`markup_pct`, `lead_time_weeks`, `ordered_at`, `eta`, `delivered_at`,
`monday_item_id`, `monday_synced_at` for every caller regardless of
role — this route is the Spec register's read path, not the Pricing &
Procurement view. **Aria-relevant** for schedule/spec reads; use
`GET /api/items/[id]` for pricing fields (admin/service context only).

**Phase 14A pagination:** optional `?limit=` (default 500, max 2000)
and `?offset=` (default 0). Response also carries `total` (exact count)
and the effective `limit`/`offset`. A caller passing no limit/offset —
every existing UI call — implicitly gets up to 500 items; see the
route's own doc comment for the honest caveat that this is a real cap,
not a guaranteed-unchanged unbounded read, if any single project's
active item count ever exceeds it.

### POST /api/projects/[id]/items
Auth: session. Body: `CreateItemInput` (`name`, `category` required;
optional `library_item_id` hydrates defaults from the library catalogue,
including `price_rrp`/`price_trade`). Response: `{ item }` (201).
`item_code` is DB-trigger-generated, never client-supplied. If
`product_url` is present, kicks off scraping fire-and-forget via
`after()` (never blocks the response). **Aria-relevant.**

---

## Items

### GET /api/items/[id]
Auth: session (financial fields admin-only). Body: none. Response:
`{ item, notes: ItemNote[] }`. `price_trade`/`markup_pct` stripped for
non-admins. **Aria-relevant.**

### PATCH /api/items/[id]
Auth: session (financial fields admin-only). Body: partial `Item` —
whitelist only (`EDITABLE_FIELDS` in `app/api/items/[id]/route.ts`):
`name, description, category, supplier, supplier_email, brand,
quantity, unit, location, application_note, colour, material, finish,
width_mm, height_mm, length_mm, depth_mm, status, product_url,
selected_image_url, image_options, scrape_status, scraped_documents,
price_rrp, price_trade, markup_pct, lead_time_weeks, ordered_at, eta,
delivered_at, decision_needed_by`. `price_trade`/`markup_pct` are
silently dropped from a non-admin body (not rejected). `item_code` is
immutable. Response: `{ item }` (stripped for non-admins). Side effect:
when `status` transitions to `"Ordered"` and no `monday_item_id` exists
yet, fires a one-way Monday sync via `after()` — fire-and-forget, never
blocks or fails the response; on failure nothing is written back (a
later status change or `POST /api/monday/sync/[itemId]` can retry).
**Aria-relevant.**

**Phase 11 extension (5 July 2026):** `decision_needed_by` (date,
migration `016_portal_v2.sql`) added to `EDITABLE_FIELDS` — this closes
the "Known gap" previously documented under "Decision deadlines" below:
the column existed and was read/rendered on the portal side since Phase
11B, but staff had no write path until now. Falls through to the plain
date-passthrough branch (not `NUMERIC`/`TEXT`/`JSON_FIELDS`), same as
`ordered_at`/`eta`/`delivered_at` — `""` becomes `null`. Surfaced in
`components/items/SpecRegister.tsx`'s expanded item row as a native
date input labelled "Client decision needed by", next to Status, using
the same single-save-per-field pattern (`onBlur` commits straight
through `onPatch`) as every other field on that row.

### DELETE /api/items/[id]
Auth: session. Body: none. Response: `{ ok: true }`. Soft-delete
(`deleted_at`). **Aria-relevant.**

### POST /api/items/[id]/scrape
Auth: session. Body: `{ url?: string }` (falls back to the item's own
`product_url` if omitted; 400 if neither is present). Response:
`{ item }` via an explicit `SCRAPE_RESULT_COLUMNS` whitelist that
excludes pricing/ordering/Monday columns. `scrapeProductUrl()` never
throws — outcome fields (`scrape_status`, `image_options`,
`scraped_documents`, etc.) are written directly onto the item row by
the scraper itself, so a 200 with the item comes back even when the
underlying scrape attempt failed (check `item.scrape_status`).
**Week 8A additive**: also best-effort extracts `width_mm`/`height_mm`/
`length_mm`/`depth_mm` (see `lib/scraper/extract.ts`
`dimensionsFromJsonLd`/`dimensionsFromText` — JSON-LD Product
width/height/depth first, then text patterns like `"Width 895 mm"` or
`"W x H x D: 895 x 455 x 560mm"`, cm/m unit-converted to mm, sanity
range 10–10000mm). Only fills fields currently `null` on the item
(never overwrites a manual/existing value), same rule as `price_rrp`.
When at least one dimension is auto-filled, `scrape_flag_note` is set
to `"Dimensions auto-read — please verify"` WITHOUT setting
`scrape_flagged` — an FYI, not a review flag — surfaced in the Spec
Register under the Product URL field alongside (not instead of) the
existing flagged-for-review line. **Aria-relevant.**

### GET /api/items/[id]/files
Auth: session. Body: none. Response: `{ files: (ItemFile & { url: string | null })[] }`,
oldest first, each with a signed URL (1hr TTL) minted from the
**private** `assets` bucket (migration 009_assets_bucket.sql — see
"Storage buckets" note below). `url` is `null` for a file whose signing
call failed (e.g. the object is missing) rather than failing the whole
list.

### POST /api/items/[id]/files
Auth: session. Body: multipart `{ file, kind }` where
`kind ∈ spec_sheet | install_manual | other`. Response:
`{ file: {...row, url} }` (201). Uploads to
`assets/items/${id}/files/${timestamp}-${slug}`; storage object is
best-effort cleaned up if the DB insert fails. On a Storage error the
response body's `error` includes the underlying Supabase Storage
message (e.g. surfaces a missing-bucket error directly, pointing at
migration 009) rather than a generic failure string.

### POST /api/items/[id]/files/from-url
Auth: session. Body: `{ url, kind }`. Response: `{ file: {...row, url} }`
(201). Server-side "Attach" for a PDF the scraper detected on the
product page: SSRF-guarded fetch, 20MB cap, uploads then inserts (same
cleanup-on-failure as above), and on success prunes the matching URL
out of the item's `scraped_documents` JSON array. `url` is a signed URL
(same TTL/bucket as above); `null` if signing failed post-upload.

### DELETE /api/item-files/[fileId]
Auth: session. Body: none. Response: `{ ok: true }`. **Hard** deletes
both the storage object and the `item_files` row (no soft-delete
column exists on this table).

### POST /api/items/[id]/image
Auth: session. Body: multipart `file`, OR JSON `{ url }`. Response:
`{ url: publicUrl }`. Uploads to `item-images/items/${id}/image-${timestamp}.${ext}`
(`upsert: true`) — the **public** `item-images` bucket (Week 7 fix: this
previously wrote to the `assets` bucket, which either didn't exist or
is now private, both of which broke `getPublicUrl()`; item cover images
are a durable value persisted onto `items.selected_image_url` and
reused indefinitely across the register/portal/PDF, so they belong in
the same public bucket the PDF pre-pass re-hosting flow already uses —
see `lib/images.ts` `PDF_IMAGE_BUCKET`). Does **not** persist the URL
onto the item — the caller must separately `PATCH /api/items/[id]` with
`selected_image_url`.

### GET /api/items/[id]/notes
Auth: session. Body: none. Response: `{ notes: ItemNote[] }`, oldest first.

### POST /api/items/[id]/notes
Auth: session. Body: `{ text }` (required, trimmed). Response:
`{ note }` (201). `author_name` denormalised from the caller's profile
full name, falling back to email, then `"Team member"`.

---

## Library (global product catalogue)

### GET /api/library
Auth: session (financial fields admin-only). Body: none. Query:
`?q=`, `?category=`, `?standard=1` (migration `030_standards_lead_notes.sql`
— only items with `is_standard = true`; this is the exact query
`components/projects/StandardItemsChecklist.tsx` calls for the "Standard
spec items" checklist at Create Project and the leads "Progress to
job" step). Response: `{ items }`, ordered `usage_count desc, name asc`,
capped at 200 (Phase 14A: `?limit=` override, max 1000; `?offset=` for
paging; response also carries `total` (exact count), `limit`,
`offset`). `FINANCIAL_FIELDS = ["price_trade",
"trade_price_received_at", "trade_price_source"]` stripped for
non-admins; `price_rrp` is NOT gated (public reference price).
**Aria-relevant.**

### POST /api/library
Auth: session (financial fields admin-only). Body: `{ name, category
(required), description?, supplier?, supplier_email?, brand?, colour?,
material?, finish?, width_mm?, height_mm?, length_mm?, depth_mm?,
product_url?, default_image_url?, price_rrp?, price_trade?,
trade_price_source?, trade_price_received_at? }`. Response: `{ item }`
(201, stripped for non-admins). A non-admin's financial fields are
silently forced to null rather than rejected. Setting `price_trade`
auto-stamps `trade_price_received_at` to today if not supplied.
`product_url_normalized` computed server-side. `is_standard` defaults
`false` on this route (not accepted at creation — flip it afterwards
via `PATCH /api/library/[id]`, same as every other library toggle).

### PATCH /api/library/[id]
Auth: session (financial fields admin-only). Body: any of the
editable fields listed under POST above, **plus** `is_standard?`
(migration `030_standards_lead_notes.sql` — boolean, not financial, not
gated; any signed-in team member can toggle it, matching every other
non-financial library field on this route). Response: `{ item }`
(stripped for non-admins). Non-admin financial-field keys in the body
are silently ignored (not rejected). The Library UI badge '★ Standard'
and its "Mark standard"/"Unmark standard" toggle
(`components/library/LibraryBrowser.tsx`) both go through this route.

### DELETE /api/library/[id]
Auth: **session only — no admin check.** Body: none. Response:
`{ ok: true }`. Hard delete. Note: this is intentionally inconsistent
with `DELETE /api/categories/[id]` (admin-only) — any signed-in team
member can permanently delete a library catalogue entry today. Flagged
here rather than silently relied upon; worth tightening in a future
pass if that turns out to be unintended.

### GET /api/library/check
Auth: session. Body: none. Query: `?url=`. Response:
`{ duplicates: DuplicateMatch[] }` — checks the normalised URL against
both `library_items` and `items` (5 each, parallel), informational
only, never blocks creation.

---

## Categories

### GET /api/categories
Auth: session. Body: none. Response: `{ categories }`, ordered
`sort_order`.

### POST /api/categories
Auth: admin. Body: `{ prefix, name, sort_order? }` (`prefix` upper-cased
and trimmed). Response: `{ category }` (201). Duplicate `prefix` is
caught as Postgres 23505 → 400 (not pre-checked).

### PATCH /api/categories/[id]
Auth: admin. Body: `{ name?, sort_order? }` — `prefix` is immutable.
Response: `{ category }`; empty body → 400 `"Nothing to update"`.

### DELETE /api/categories/[id]
Auth: admin. Body: none. Response: `{ ok: true }`. Hard delete; a
foreign-key violation (category still referenced by items, 23503)
returns 400 `"This category is in use by items and can't be deleted"`.

---

## Estimate module (admin-only, financial)

Every route below is whole-route 403'd for non-admins before any query
runs — this entire module is financial data per BUILD-SPEC.md
"Financial visibility".

### GET /api/projects/[id]/estimate
Auth: admin. Body: none. Response: `EstimateResponse` —
`{ sections: CostSectionWithLines[], markup_pct, rollup: {
allTradesSubtotalExGst, approvedVariationsExGst, markupPct,
markupExGst, totalToClientExGst, gst, totalIncGst, quotedExGst,
actualExGst }, ffe: FfeRollup, wholeJob: WholeJobSummary,
measurements: MeasurementWithGroup[] }`. Week 6 additive: `ffe` and
`wholeJob` — see "FF&E — from schedule" below. Week 7 additive:
`measurements` — every project measurement, flat, each with its
group's name attached (`group_name`) — powers the cost-line
measurement-link picker and lets the UI resolve a linked line's
`measurement_id` to a label/value/unit without a second fetch. Cost
lines with a non-null `measurement_id` have their contribution to
`rollup.allTradesSubtotalExGst` (and their own `cost_ex_gst` display,
when not manually overridden) computed from
`lib/estimate.ts effectiveQty()` — `measurement.value * (1 +
wastage_pct/100)` — rather than the line's own `qty` column; see
"Cost lines" below. Sections/lines are ordered by `sort`, non-deleted
only. **Aria-relevant** (read-only estimate visibility for an
admin-scoped agent context).

### POST /api/projects/[id]/estimate/init
Auth: admin. Body: none. Response: `{ sections: CostSectionWithLines[] }`
(201) or 409 if sections already exist for the project. Seeds from the
default `estimate_templates` row plus two default measurement groups
(Floor Areas, Tiling Areas).

### PATCH /api/projects/[id]/estimate/markup
Auth: admin. Body: `{ markup_pct: number }` (fraction, 0–9.9999).
Response: `{ project }` or the updated markup value — updates
`projects.estimate_markup_pct`.

### POST /api/projects/[id]/estimate/sections
Auth: admin. Body: `{ name }`. Response: `{ section }` (201).
`sort = max(existing) + 1`.

### PATCH /api/estimate/sections/[sectionId]
Auth: admin. Body: `{ name? }`. Response: `{ section }`.

### DELETE /api/estimate/sections/[sectionId]
Auth: admin. Body: none. Response: `{ ok: true }`. Cascades to the
section's lines (FK `on delete cascade`).

### POST /api/estimate/sections/[sectionId]/lines
Auth: admin. Body: `CreateCostLineInput` — `{ description (required),
qty?, unit?, rate_ex_gst?, cost_ex_gst?, quoted_to_client_ex_gst?,
actual_paid_ex_gst?, quote_status? ('Q'|'S'|'NA'), item_id?, notes? }`.
Response: `{ line }` (201).

### PATCH /api/estimate/lines/[id]
Auth: admin. Body: `PatchCostLineInput` — any subset of the
`CreateCostLineInput` fields plus `sort`, `measurement_id`,
`wastage_pct` (Week 7). Response: `{ line }`. Setting `item_id` ties
the line to a spec register item — per the "double-counting rule" (see
FF&E section below), this marks the line as labour/install only in the
UI. Setting `measurement_id` (references `measurements(id)`, `on delete
set null`) links the line to a measurement row — its effective qty
becomes `measurement.value * (1 + wastage_pct/100)` (see
`lib/estimate.ts effectiveQty()`), overriding the line's own `qty`
column for cost purposes while leaving `qty` itself untouched (unlink
by setting `measurement_id: null` to hand-edit qty again). `wastage_pct`
is validated 0–50 (400 outside that range); only meaningful alongside a
non-null `measurement_id`, but not rejected if set without one.

### DELETE /api/estimate/lines/[id]
Auth: admin. Body: none. Response: `{ ok: true }`. Soft-delete
(`deleted_at`).

### GET /api/projects/[id]/estimate/variations
Auth: admin. Body: none. Response: `{ variations: Variation[] }`.

### POST /api/projects/[id]/estimate/variations
Auth: admin. Body: `CreateVariationInput` — `{ description (required),
var_date?, cost_ex_gst?, status? ('proposed'|'approved'|'rejected'),
approved_by?, requested_by?, item_id?, notes? }`. Response:
`{ variation }` (201). `var_number` auto-computed as
`max(all rows incl. soft-deleted) + 1` per project.

### PATCH /api/estimate/variations/[id]
Auth: admin. Body: `PatchVariationInput`. Response: `{ variation }`.
Only `status = 'approved'` variations feed into `projectRollup()`'s
approved-variations total.

### DELETE /api/estimate/variations/[id]
Auth: admin. Body: none. Response: `{ ok: true }`. Soft-delete.

### GET /api/projects/[id]/estimate/measurements/groups
Auth: admin. Body: none. Response: `{ groups: MeasurementGroupWithRows[] }`
(each with nested `measurements` and a computed `total`).

### POST /api/projects/[id]/estimate/measurements/groups
Auth: admin. Body: `{ name }`. Response: `{ group }` (201).

### POST /api/estimate/measurements/groups/[groupId]/measurements
Auth: admin. Body: `CreateMeasurementInput` — `{ label (required),
value?, unit? (default 'm2'), item_id?, notes? }`. Response:
`{ measurement }` (201).

### PATCH /api/estimate/measurements/[id]
Auth: admin. Body: `PatchMeasurementInput`. Response: `{ measurement }`.

### DELETE /api/estimate/measurements/[id]
Auth: admin. Body: none. Response: `{ ok: true }`. **Hard** delete (no
`deleted_at` column on `measurements`).

### PATCH /api/estimate/measurements/groups/[groupId]
Auth: admin. Body: `{ name? }`. Response: `{ group }`.

### DELETE /api/estimate/measurements/groups/[groupId]
Auth: admin. Body: none. Response: `{ ok: true }`. Hard-deletes the
group; its measurements cascade.

---

## FF&E — from schedule (Week 6, additive, part of the Estimate module)

Not a separate route — folded into `GET /api/projects/[id]/estimate`'s
`ffe` and `wholeJob` response fields (see above). Computed in
`lib/estimate.ts` (`ffeRollup()`, `wholeJobSummary()`) from the
project's non-deleted `items` (never from `cost_lines` — schedule
items are never duplicated as cost lines). Per category: item count,
total (`sum(qty × bestPrice)`), confidence split, where
`bestPrice = price_trade ?? price_rrp` and each item is tagged
`'quoted'` (price_trade set), `'placeholder'` (falls back to price_rrp),
or `'unpriced'` (neither set).

**Markup cascade decision**: FF&E is priced and profited on separately
from the trade estimate — `projects.estimate_markup_pct` only applies
to `cost_lines` (trade costs), never to FF&E. `wholeJobSummary()` adds
`ffe.total` to `trades.totalToClientExGst` **after** trade markup has
already been applied, then re-derives GST over the combined figure.
See the comment block above `wholeJobSummary()` in `lib/estimate.ts`
for the full rationale (folding FF&E into the pre-markup base would
double-apply a margin never priced into the FF&E figure, and would
conflate two distinct profit mechanisms the business tracks
separately).

---

## Invoices (admin-only, financial) — Week 6

BUILD-SPEC.md "Invoice pipeline — AI-updated actuals": AI proposes, an
admin approves — no silent money writes. These routes are the ones
Aria is expected to drive most heavily for this feature.

### GET /api/projects/[id]/invoices
Auth: admin. Body: none. Query: `?status=` (`unmatched|proposed|approved|rejected`).
Response: `{ invoices: Invoice[] }`, newest first. **Aria-relevant.**

### POST /api/projects/[id]/invoices
Auth: admin. Body: JSON `{ supplier, invoice_number, invoice_date?,
amount_ex_gst, gst?, total?, proposed_match_type? ('cost_line'|'item'),
proposed_match_id?, confidence_note? }`, OR multipart form-data with
the same fields plus an optional `file` (PDF) — supports both Aria
posting programmatically (JSON, no file) and the queue UI's manual
upload form. `gst`/`total` default to a 10% GST computation off
`amount_ex_gst` if omitted. Setting `proposed_match_type` +
`proposed_match_id` at creation starts the row at `status: 'proposed'`
instead of `'unmatched'`. Response: `{ invoice, duplicate_warning? }`
(201) — `duplicate_warning` (an `Invoice`) is present when a
non-rejected invoice already exists for the same
`(project, supplier, invoice_number)`; the new invoice is still
created (warn, not block — matches the partial unique index
`idx_invoices_project_supplier_number_live` in
`007_estimating.sql`, which excludes `status = 'rejected'`). A
genuine race on the same key is caught as Postgres 23505 → 409.
**Aria-relevant.**

### PATCH /api/invoices/[id]
Auth: admin. Body: any of `{ supplier?, invoice_number?,
invoice_date?, amount_ex_gst?, gst?, total?, confidence_note? }` plus
optionally `{ proposed_match_type, proposed_match_id }` together —
setting both (non-null) validates the target row exists in the same
project (`cost_lines` or `items` depending on `proposed_match_type`)
and flips `status` to `'proposed'`; setting both to `null` clears the
match and drops `status` back to `'unmatched'` if it was `'proposed'`.
Response: `{ invoice }`. Rejects edits to an already `approved` or
`rejected` invoice (400) — those are terminal states. **Aria-relevant.**

### POST /api/invoices/[id]/approve
Auth: admin. Body: none. Response: `{ invoice }`, or `{ invoice,
warning }` with HTTP 207 if the invoice was approved but its matched
cost line couldn't be found/updated. Requires a proposed match to
exist first (400 otherwise). Sets `status: 'approved'`,
`approved_by`, `approved_at`, then:
  - **cost_line match**: ADDS `amount_ex_gst` to the line's existing
    `actual_paid_ex_gst` (`COALESCE(existing, 0) + amount_ex_gst`) —
    this is what makes partial invoices work (a deposit invoice
    approved now, a balance invoice approved later, without losing the
    first payment). Variance recalculates for free on next read via
    the existing `lineVariance()` rollup math — no separate variance
    column.
  - **item match**: does **nothing automatic** to the item's
    `price_trade` or any other pricing field — only the linkage
    (already set by the propose step) is preserved as an audit trail.
    `price_trade` is the negotiated per-unit quote price, captured
    once via the library/scraper trade-price flow; it is not the same
    figure as "amount this invoice paid" (an invoice can cover partial
    quantity, freight, multiple items). Item-level actuals are
    intentionally routed through `cost_lines.actual_paid_ex_gst`, not
    by mutating spec register pricing as a side effect of invoice
    approval. **Aria-relevant** — but note the asymmetry: only
    cost_line matches move money automatically.

### POST /api/invoices/[id]/reject
Auth: admin. Body: none. Response: `{ invoice }`. Sets
`status: 'rejected'`. No financial writes. A rejected invoice drops
out of the duplicate-detection unique index's scope, so the same
supplier+number can be resubmitted cleanly. **Aria-relevant.**

---

## Client invoices (admin-only, financial) — Client invoicing phase 1

BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 5: branded tax
invoices RESLU raises against ITS OWN client — money IN, the opposite
direction of the "Invoices" section above (supplier bills, money OUT).
Table `client_invoices` (migration `046_client_invoices.sql`) — do not
confuse with the `invoices` table above. Phase 1 = design fees, manual
line items only, no progress-claim generation yet. Every route below is
admin-gated. Project-scoped only — there is no global `/invoices` list
in v1 (documented decision, not an oversight).

### GET /api/projects/[id]/client-invoices
Auth: admin. Body: none. Response: `{ invoices: ClientInvoice[] }`,
newest first, excluding soft-deleted rows.

### POST /api/projects/[id]/client-invoices
Auth: admin. Body: `{ kind? ('design_fee'|'other', default
'design_fee'), client_name, client_email?, address?, line_items:
[{description, amount_ex_gst}], due_days? (default 14), notes? }`.
`invoice_number` and `subtotal_ex_gst`/`gst`/`total_inc_gst` are ALWAYS
server-computed (`lib/client-invoices.ts` `nextInvoiceNumber()` +
`computeTotals()`) — never accepted from the client. Numbering:
`{job_number}-{seq}` (2-digit, per-project, counts void invoices) when
the project has a `job_number`, else `GEN-{seq}` (global sequence).
Rounding: subtotal and GST are each rounded half-up to whole cents
independently, then summed for the total (not `subtotal * 1.1` rounded
once — see that lib's own header comment for why). Starts at
`status: 'draft'`. Response: `{ invoice }` (201), 409 on the rare
invoice_number race (one retry already covers the common case).

### GET /api/client-invoices/[id]
Auth: admin. Body: none. Response: `{ invoice }`.

### PATCH /api/client-invoices/[id]
Auth: admin. Body: any of `{ kind?, client_name?, client_email?,
address?, line_items?, due_days?, notes? }`. Only permitted while
`status = 'draft'` (400 otherwise — a sent/paid tax invoice's figures
are frozen; void it and raise a new one instead of editing in place).
Recomputes totals server-side whenever `line_items` is present.
Response: `{ invoice }`.

### GET /api/client-invoices/[id]/pdf
Auth: admin. Body: none. Renders the branded tax invoice PDF
(`components/pdf/InvoicePdf.tsx`) — works in any status, so this also
backs the composer's "Preview PDF" action on a still-draft invoice.
Response: `application/pdf`, `Cache-Control: no-store`.

### POST /api/client-invoices/[id]/send
Auth: admin. Body: none. Renders the same PDF, emails it via Resend
(`lib/resend.ts`, from `RESLU <accounts@reslu.com.au>`, reply-to
`phillip@reslu.com.au`) with the PDF attached as base64 (falls back to
a text-only note if the rendered PDF exceeds 5MB — should never happen
for a real design-fee invoice). Logs to `email_sends`
(`record_type: 'client_invoice'`, `template: 'client-invoice'`). On a
real (non-skipped) send: `status → 'sent'`, `issued_at` set (first-send
timestamp, preserved across any later resend). **Divergence from
`lib/visit-emails.ts`: the 7am-7pm Adelaide send-window rule is NOT
applied here** — an admin-triggered invoice send is a deliberate
business action, not an unsolicited lifecycle notification; it goes out
immediately or fails immediately, never queued to `email_sends`
'pending'. 400 if the invoice has no `client_email` or is `void`. 503
if `RESEND_API_KEY` isn't configured.

### POST /api/client-invoices/[id]/mark-paid
Auth: admin. Body: none. Sets `status: 'paid'`, `paid_at`. Manual
reconciliation marker only — MYOB stays the ledger of record (BUILD-
SPEC.md DECISIONS: "MYOB stays, manual entry"), no API sync in phase 1.
Rejected (400) if already `paid`/`void`.

### POST /api/client-invoices/[id]/void
Auth: admin. Body: none. Sets `status: 'void'` — terminal, and the
invoice_number is never reissued (`nextInvoiceNumber()` counts void
rows in its sequence). Rejected (400) if already `paid`/`void`.

### POST /api/client-invoices/[id]/stripe-link
Auth: admin. Body: none. Explicit-only action (never auto-triggered).
503 if `STRIPE_SECRET_KEY` isn't set. Plain fetch (no SDK) to Stripe's
`POST /v1/payment_links`, one ad-hoc price_data line item for
`total_inc_gst` in cents. On success, stores the returned `url` on
`stripe_payment_url`, which is what turns on the PDF/email's "Pay
online" button. Intended for small (design-fee-sized) invoices — bank
transfer remains the standard method. 400 if the invoice is
`paid`/`void`.

### GET / PUT /api/settings/bank-details
Auth: admin (both methods — unlike most `app_settings`-backed Settings
editors in this codebase, bank details are financial). `app_settings`
key `invoice_bank_details`, `{ account_name, bsb, account_number }`, all
three required together. GET response: `{ bank_details: {...} | null }`
— `null` until an admin saves real values (no invented fallback — see
`lib/bank-details.ts`); every invoice PDF shows "Bank details not
configured" until then. PUT response: `{ bank_details }`.

---

## Project documents — Week 6

Team-visible (**not** admin-gated — documents aren't financial, per
BUILD-SPEC.md "Project documents").

### GET /api/projects/[id]/files
Auth: session. Body: none. Response:
`{ files: (ProjectFile & { url: string | null })[] }`, non-deleted,
newest first. Each `kind ∈ plans | council | engineering |
scope_of_works | other`. `url` is a signed URL (1hr TTL) from the
**private** `assets` bucket, `null` if signing failed.

### POST /api/projects/[id]/files
Auth: session. Body: multipart `{ file, kind, revision_label? }`
(e.g. `"T3"`). Response: `{ file: {...row, url} }` (201). Uploads to
the same `assets` bucket item_files uses, under
`projects/${id}/files/${timestamp}-${slug}`. On a Storage error the
response body's `error` includes the underlying Supabase Storage
message.

### DELETE /api/project-files/[fileId]
Auth: session, but restricted to admin **or** the original uploader
(403 otherwise). Body: none. Response: `{ ok: true }`. **Soft**
delete (`deleted_at`) — unlike `item_files`, revision history is kept
recoverable rather than destroying the storage object.

---

## Project overview hub + document traffic lights — Week 8A

Team-visible (not admin-gated — a document's completion status isn't
financial, same trust tier as `project_files`).

### GET /api/projects/[id]/overview
Auth: session. Body: none. Response: `ProjectOverviewResponse` —
`{ project, ffe: { item_count, approved_count, flagged_count,
ordered_count }, documents: { kind, status, latest_revision_label }[],
estimate: { total_inc_gst, percent_quoted, variance } | null,
client_activity: (ApprovalEvent & { item_code, item_name })[] }`.
Backs the Overview tab's four cards. `documents` covers the four
tracked kinds (`plans|council|engineering|scope_of_works` — `other`
has no traffic light); each kind's `status` resolves via
`lib/sow.ts documentStatusFor()` (stored value, or the kind's default —
`'not_started'`/red for all four tracked kinds — when unset).
`estimate` is `null` entirely for non-admins (field-stripped, not
merely hidden) and also `null` for admins when the project's estimate
hasn't been initialised yet. `client_activity` is the last 5
`approval_events` for the project (joined through `items` — the table
has no `project_id` column of its own), newest first. **Aria-relevant**
(read-only project status snapshot).

### PATCH /api/projects/[id]/document-status
Auth: session (NOT admin-gated). Body: `{ kind, status }` where
`kind ∈ plans | council | engineering | scope_of_works | other` and
`status ∈ na | not_started | draft | done`. Response:
`{ document_status }` (the full merged jsonb map). Merges into
`projects.document_status` rather than replacing it — setting one
kind's status never clobbers another's. Powers the click-to-cycle
traffic light dot on both the Overview card and the Documents tab's
section headers (`na -> not_started -> draft -> done -> na`, see
`lib/sow.ts nextDocumentStatus()`).

---

## Scope of Works builder — Week 8A

Team-visible (not admin-gated — a SOW isn't financial data). Aria
integration: BUILD-SPEC.md "Scope of Works builder" — "API routes for
SOW CRUD so Aria can draft a SOW from project docs ... and the team
refines" — every route below is **Aria-relevant**.

### GET /api/projects/[id]/sow
Auth: session. Body: none. Response: `{ sow_documents: SowDocument[] }`,
every non-deleted revision for the project, newest first
(`created_at desc`) — powers the revision picker.

### POST /api/projects/[id]/sow
Auth: session. Body: `{ revision_label? }` (defaults to `"T1"`).
Response: `{ sow, sections: SowSectionWithLines[] }` (201). Creates the
project's **first** SOW only (subsequent revisions come from
`POST .../[sowId]/new-revision`, not this route — calling it again
would create an unrelated, unlinked second revision). Seeds sections
via `lib/sow.ts seedSowSections()`: `General / Preliminaries`, then one
section per the project's distinct non-null `items.location` values
(alphabetical), or `Kitchen, Main Bathroom, Ensuite, Laundry` if the
project has no located items yet, then `Exclusions`, `Assumptions`. A
duplicate `revision_label` for the same project 409s (partial-unique
index `idx_sow_documents_project_revision_active`).

### GET /api/projects/[id]/sow/[sowId]
Auth: session. Body: none. Response: `{ sow, sections:
SowSectionWithLines[] }` — one revision with its sections and lines
nested, sorted by `sort`.

### DELETE /api/projects/[id]/sow/[sowId]
Auth: session. Body: none. Response: `{ ok: true }`. Soft-delete
(`deleted_at`) — drops the revision from the GET list/picker. No status
guard: an issued SOW can still be soft-deleted here (issued only
protects it from in-place editing, not from being retired).

### POST /api/projects/[id]/sow/[sowId]/sections
Auth: session. Body: `{ heading }`. Response:
`{ section: SowSectionWithLines }` (201). 409 if the parent SOW's
`status = 'issued'` (immutable — see "New revision" below).

### PATCH /api/sow/sections/[sectionId]
Auth: session. Body: `{ heading?, sort? }`. Response: `{ section }`.
409 if the parent SOW is issued.

### DELETE /api/sow/sections/[sectionId]
Auth: session. Body: none. Response: `{ ok: true }`. Hard-deletes;
`sow_lines` cascade. 409 if the parent SOW is issued.

### POST /api/sow/sections/[sectionId]/lines
Auth: session. Body: `{ text, kind? }` (`kind ∈ inclusion | exclusion |
note`, defaults `'inclusion'`). Response: `{ line }` (201). Same
single-save draft-row pattern as `components/estimate`'s
`DraftLineRow`. 409 if the parent SOW is issued.

### PATCH /api/sow/lines/[lineId]
Auth: session. Body: `{ text?, kind?, sort? }`. Response: `{ line }`.
409 if the parent SOW is issued.

### DELETE /api/sow/lines/[lineId]
Auth: session. Body: none. Response: `{ ok: true }`. Hard delete. 409
if the parent SOW is issued.

### POST /api/projects/[id]/sow/[sowId]/issue
Auth: session. Body: none. Response: `{ sow }`. Sets `status: 'issued'`
+ stamps `issued_at`; every section/line write route above then 409s
against this SOW until a new revision exists. 400 if already issued.
Side effect: also sets `projects.document_status.scope_of_works =
'done'` directly (not via the PATCH document-status route — so issuing
can never silently skip flipping the traffic light).

### POST /api/projects/[id]/sow/[sowId]/new-revision
Auth: session. Body: none. Response: `{ sow }` (201). Only valid from
an **issued** SOW (400 otherwise — a draft is already editable in
place). Clones every section + line into a brand-new draft at the next
free `T`-number (`nextRevisionLabel()` in `lib/sow.ts`, advancing past
any existing label to avoid a collision if revisions were issued out of
order). The source SOW is left untouched — still issued, still
immutable — so what was actually issued to the client remains exactly
as issued even after a later revision exists. Side effect: sets
`projects.document_status.scope_of_works = 'draft'` (the new draft
supersedes the issued one as "current").

### GET /api/projects/[id]/sow/[sowId]/pdf
Auth: session. Body: none. Response: raw PDF binary
(`Content-Disposition: inline`, `Cache-Control: no-store`). React-PDF,
RESLU brand — cover mirrors `docs-sow-reference.docx`'s placeholder
structure (logo, "Scope of Works", project name, address-as-description,
Project/Client/Project No./Date/Issue block); body renders each
section as a sand spaced-caps heading, inclusions as a bulleted list,
exclusions grouped under a cream-panel "Exclusions" treatment, notes in
italic; footer styled like the FF&E schedule PDF's. `projectNo` is
derived from the project id's first 8 characters (uppercased) — the
schema has no dedicated project-number column.

---

## Portal expansion & native e-signature — Week 8B

Folded in from the former `docs/API-portal-additions.md` (now deleted).
Written in the same auth-tier vocabulary as above: **session**,
**session (financial fields admin-only)**, **admin**, **portal-token**.

**Superseded by Phase 11B below** for the portal page's section names/
layout ("Schedule & approvals" -> "Selections", "Updates" -> "Diary",
plus new What's next / Handover sections) — this section is kept as
historical record of what Week 8B shipped; see "Portal v2, diary,
gallery & notifications (Phase 11B)" further down for the current
behaviour. The variation-respond and native e-signature routes
documented below are unchanged and still current.

### GET /portal/[token] (page, not an API route)
Auth: portal-token. No longer just the FF&E schedule — now renders every
sectioned area described below in one server-rendered page: Schedule &
approvals (unchanged), Documents, Contracts & signatures, Variations,
Progress photos, Updates. Still carries no item pricing; the one
deliberate exception is variation cost, shown **inc GST only**.

### Variations — portal response

#### POST /api/portal/[token]/variation/[id]/respond
Auth: portal-token. Body: `{ response: "approved" | "declined", note?: string }`.
Response: `{ variation: { id, var_number, var_date, description, cost_inc_gst, client_response, client_response_note, client_responded_at } }`.
Verifies the variation belongs to the token's project AND has
`share_to_portal = true` before accepting a response (same ownership
discipline as the existing item approve/flag route). Rate-limited.
Records a digest-queue entry via `lib/gmail/digest.ts`'s
`recordPortalAction()` (never blocks the response). `cost_inc_gst` is
computed server-side from `cost_ex_gst * 1.10` — the client never
supplies or sees `cost_ex_gst` directly.

### Native e-signature

#### GET /api/portal/[token]/sign/[requestId]
Auth: portal-token. Response: `{ target: PortalSigningTarget, consentStatement }`.
`target.document_url` is a signed URL (1hr TTL) to the underlying PDF for
`project_file` subjects, or `null` for `variation`/`sow` subjects (no
stored PDF to preview — the sign page shows a text summary instead).
Rate-limited.

#### POST /api/portal/[token]/sign/[requestId]
Auth: portal-token. Body:
`{ signature_data_url: string (PNG data URL), signer_name_typed: string, consent: boolean }`.
Response: `{ status: "signed", signed_at, certificate_url }` or `{ error }`
(400/404/409/500). This is the security-critical route — implements
BUILD-SPEC.md §"Built-in digital signature" exactly:

1. Rejects unless `consent === true` and a non-empty typed name and a
   non-empty decoded PNG signature are present.
2. Verifies the `signature_requests` row belongs to the token's project
   and is still `pending` (409 if already `signed`/`void`).
3. **Recomputes `document_sha256` server-side** from the actual stored
   bytes (`lib/signatures.ts` `resolveDocumentBytes` + `sha256Hex`) —
   never trusts a client-supplied hash. For `project_file` subjects this
   downloads the real object from Storage; for `variation` subjects (no
   stored PDF) it hashes a canonical JSON snapshot of the variation's
   id/number/description/cost/date, which is what the void-on-edit
   trigger (migration 012) invalidates when the variation later changes.
4. Uploads the drawn signature PNG to the **private** `assets` bucket
   (`signatures/{projectId}/{requestId}/...-signature.png`).
5. Inserts one **append-only** `signature_events` row (see schema below)
   via the service-role client, then flips `signature_requests.status`
   to `'signed'`.
6. Best-effort (never fails the response): renders a branded
   signature-certificate PDF via React-PDF (`components/portal/SignatureCertificatePdf.tsx`),
   uploads it as a **new** object next to the original (never overwriting
   it), indexes it as a `project_files` row (`kind: 'other'`) for
   `project_file` subjects, and emails admins via `lib/gmail/send.ts` if
   Gmail is configured. **Note (Phase 11 extension, 5 July 2026):**
   `projects.client_email` now exists (migration `016_portal_v2.sql`,
   surfaced in Project settings this release) and `lib/notify-client.ts`
   is wired into request-*creation* (see `POST /api/signatures` below),
   but this sign-*completion* route itself is untouched this release —
   it still only emails admins, not the client, on a completed
   signature. Wiring a "your signature was received" client
   confirmation here is a natural follow-up, not done in this pass (out
   of this task's stated scope: "wire lib/notify-client.ts into
   signature-request creation").

Rate-limited tighter than reads (10/min vs the usual 30/min) since this
is the one portal route that writes durable, non-reversible evidence.

### Signature requests — team-side

#### POST /api/signatures
Auth: session (any team member — NOT admin-only; only variation
**sharing**, below, is admin-gated). Body:
`{ project_id, subject_type: "project_file"|"variation"|"sow", subject_id }`.
Response: `{ request }` (201). Validates the subject exists and belongs
to `project_id` for `project_file`/`variation` subject types before
creating the request (no `sow` table exists in this agent's boundary —
`sow` subjects are trusted at face value here).

**Phase 11 extension (5 July 2026):** now calls `notifyClient(supabase,
project_id, { trigger: "signature_requested", label, section:
"contracts" })` fire-and-forget (`void`, no `after()`) immediately
after the insert succeeds — same placement/pattern as every other
`notifyClient` call site (diary publish, document/variation
share-to-portal): after the DB write's error/null check, before the
JSON response, never blocking or failing request creation on a
notification failure. This closes the one documented gap in
`lib/notify-client.ts`'s module doc comment ("NOT wired: signature
request creation"). `label` is the document's `filename` for
`project_file` subjects, `"Variation #{var_number}"` for `variation`
subjects, or the generic fallback `"a document"` for `sow` subjects (no
SOW table in this boundary to look up a title from).

#### GET /api/signatures?project_id=...
Auth: session. Response: `{ requests: (SignatureRequest & { evidence })[] }`
— each request's most recent `signature_events` row (signer name, signed
at) is attached inline so the client-area UI doesn't need a second
round-trip per row.

#### GET /api/signatures/[id]
Auth: session. Response: `{ request, evidence, certificate_url }`.
`certificate_url` is a freshly-signed URL to the generated certificate
PDF (re-derived by listing the `signatures/{projectId}/{requestId}/`
Storage prefix — the certificate's exact filename is timestamped, not
fixed).

#### PATCH /api/signatures/[id]
Auth: session. Body: `{ action: "void", reason?: string }`. Sets
`status = 'void'`, `voided_reason`, `voided_at`. This is the **manual**
half of void-on-change: `project_files` revisions are new rows (not
edits), so there's no UPDATE for a trigger to catch — the team manually
voids the old file's signature request when uploading a superseded
revision. (Variations DO auto-void via a database trigger on
`cost_ex_gst`/`description` UPDATE — see migration 012 PART 6 — no route
needed for that case.)

### Team-side client area

All routes below are **session** (any team member) unless noted.

#### GET /api/projects/[id]/client-updates/summary
One-shot summary for the client-area page: files (with
`share_to_portal`), variations (with `share_to_portal` + client
response), signature requests, updates, photo count, and the fortnightly
cadence figure: `{ cadence: { last_published_at, days_since_last_update, stale } }`
(`stale = true` when `days_since_last_update > 14` or no update has ever
been published).

#### GET/POST /api/projects/[id]/client-updates/photos
GET → `{ photos: (ProgressPhoto & { url })[] }`, newest first. POST →
multipart `{ files[] (multiple), caption?, taken_at? }`, uploads each
file sequentially into the private `assets` bucket
(`projects/{id}/progress/...`), returns `{ photos: created[], errors[] }`
(207-like partial-success shape, but responds 201 as long as at least one
file succeeded, 500 if all failed).

#### PATCH/DELETE /api/projects/[id]/client-updates/photos/[photoId]
PATCH body: `{ caption?, taken_at? }`. DELETE soft-deletes
(`deleted_at`).

#### GET/POST /api/projects/[id]/client-updates/posts
GET → `{ updates: PortalUpdate[] }`, ALL rows (drafts + published) for
the team draft list — not the portal's published-only feed (that's the
inline query in `app/portal/[token]/page.tsx`). POST body:
`{ title, body_richtext }` → creates a **draft** (`published_at: null`).
Aria-relevant: `post_client_update` MCP tool wraps this route (drafts
only — this route never publishes).

#### PATCH/DELETE /api/projects/[id]/client-updates/posts/[postId]
PATCH body: `{ title?, body_richtext?, publish?: boolean }`.
`publish: true` sets `published_at = now()` **only if currently null**
(re-publishing doesn't reset the cadence clock); `publish: false`
un-publishes. DELETE soft-deletes.

#### PATCH /api/projects/[id]/client-updates/files/[fileId]/share
Body: `{ share_to_portal: boolean }`. Team-authenticated, not admin-only
— documents aren't financial (same gating as the rest of the Documents
feature).

#### PATCH /api/projects/[id]/client-updates/variations/[variationId]/share
Body: `{ share_to_portal: boolean }`. **Auth: admin.** The one
admin-gated action in this whole feature — "it exposes client pricing
decisions" (BUILD-SPEC.md). Enforced server-side (403 for non-admins
before any query runs), not merely disabled in the UI.

### Schema reference (migration `012_portal_expansion.sql`)

- `portal_updates(id, project_id, title, body_richtext, author_id, published_at?, created_at, updated_at, deleted_at?)`
- `progress_photos(id, project_id, storage_path, caption?, taken_at?, uploaded_by, created_at, deleted_at?)`
- `project_files.share_to_portal boolean default false` (additive)
- `variations.share_to_portal boolean default false`, `.client_response ('approved'|'declined')?`, `.client_response_note?`, `.client_responded_at?` (additive)
- `signature_requests(id, project_id, subject_type, subject_id, status, requested_by, voided_reason?, voided_at?, created_at, updated_at)`
- `signature_events(id, project_id, subject_type, subject_id, signature_request_id?, document_sha256, signer_name_typed, signature_image_path, portal_token_used, ip?, user_agent?, signed_at)` —
  **append-only**: RLS grants `authenticated` INSERT + SELECT only; there
  is no UPDATE or DELETE policy on this table at all (not even for
  `authenticated`), which is the actual enforcement mechanism. The portal
  sign route inserts via the service-role client (bypasses RLS by
  definition — this is the "INSERT via service role for portal" clause,
  not a policy naming `service_role`).
- Trigger `trg_void_signature_on_variation_change`: on `variations`
  UPDATE, if `cost_ex_gst` or `description` changed AND a
  `signature_events` row already exists for that variation, sets any
  `signed` `signature_requests` row for it to `void`.

---

## Address Book, Project board & Gantt — Week 9

Folded in from the former `docs/API-week9-additions.md` (now deleted).
Every route below is **session** (team-visible, not admin-gated) — none
of Week 9's data is financial (contacts are a trade/supplier directory;
boards and phases are scheduling/task data), per BUILD-SPEC.md "Week 9 —
detailed scope". All routes are **Aria-relevant** (BUILD-SPEC.md: "API
routes for everything (Aria operates boards/contacts too)").

### Address Book (contacts)

#### GET /api/contacts
Auth: session. Query: `?q=` (search across company/contact_name/
specialty, ILIKE), `?category=` (exact match). Response:
`{ contacts: Contact[] }`, non-deleted, ordered `company asc`.
Phase 14A: previously unbounded; now capped at `?limit=` (default 500,
max 2000) with `?offset=` paging and `total`/`limit`/`offset` in the
response. **Aria-relevant** (`list_contacts` MCP tool).

#### POST /api/contacts
Auth: session (any team member — same trust tier as
`POST /api/library`, which any signed-in member may also create).
Body: `CreateContactInput` — `{ company (required), contact_name?,
phone?, email?, website?, specialty?, category?, notes? }`. Response:
`{ contact }` (201).

#### GET /api/contacts/[id]
Auth: session. Response: `{ contact }`.

#### PATCH /api/contacts/[id]
Auth: session. Body: `PatchContactInput` (partial) — whitelist only.
Empty strings become `null` except `company`, which must stay
non-empty (400 otherwise). Response: `{ contact }`.

#### DELETE /api/contacts/[id]
Auth: session. Response: `{ ok: true }`. **Soft**-delete (`deleted_at`)
— per the build brief's explicit column list, and because a contact may
still be referenced by board cards / cost lines / items / phases via
`on delete set null` FKs; a soft delete keeps the row resolvable by a
direct id lookup (e.g. `GET /api/contacts/[id]` from a stale link) while
hiding it from every list immediately.

### Link points (existing routes, extended)

#### PATCH /api/items/[id] (extended)
`EDITABLE_FIELDS` gains `supplier_contact_id` (uuid, references
`contacts(id) on delete set null`) — team-visible, not financial, so no
admin-gating added for this one field. Picking a contact in the item
detail panel autofills `supplier`/`supplier_email` client-side (only
when those fields are currently empty) and sends them in the same PATCH
body as `supplier_contact_id` — the route itself has no special-case
logic for this; it's just three whitelisted fields landing in one
request.

#### PATCH /api/estimate/lines/[id] (extended)
`EDITABLE_FIELDS` gains `contact_id` (uuid, references `contacts(id) on
delete set null`) — "who's quoting/doing the trade" for a cost line.
Still admin-only overall (this route's whole surface is financial, per
BUILD-SPEC.md "Financial visibility") — the contact link itself isn't
financial data, but it lives on a financial-gated row, so the existing
route-level 403 applies to this field the same as every other field on
`cost_lines`.

### Project board (kanban)

#### GET /api/projects/[id]/board
Auth: session. Response: `{ columns: BoardColumnWithTasks[] }` — each
column's non-deleted tasks, sorted, each task annotated with lightweight
assignee (`{ id, full_name }`) and contact (`{ id, company,
contact_name }`) display data (batched lookups, not N+1). **Seeds the
project's default columns idempotently on first visit** (To Do / In
Progress / Waiting / Done) — only when the project currently has zero
columns, so calling this twice never double-seeds. The Board page
(`app/(dashboard)/projects/[id]/board/page.tsx`) duplicates this same
seed-if-empty check directly via `createClient()` rather than calling
this route internally, per this codebase's existing sub-page convention
(every other project sub-page queries Supabase directly server-side,
never fetches its own API routes) — both copies are intentionally
identical in shape.

#### POST /api/projects/[id]/board
Auth: session. Body: `CreateBoardTaskInput` — `{ column_id (required),
title (required), description?, assignee_id?, contact_id?, due_date? }`.
Response: `{ task }` (201). Validates `column_id` belongs to this
project (400 otherwise — a forged cross-project column id is rejected,
not silently accepted). `sort` = server-computed `max(existing sort in
this column) + 1000` — see "Sort scheme" below. **Aria-relevant**
(`create_board_task` MCP tool).

#### PATCH /api/board-tasks/[id]
Auth: session. Body: `PatchBoardTaskInput` (partial) — used for both
plain field edits (title/description/assignee/contact/due_date) AND
drag-drop moves (`column_id` + `sort` together in one request). When
`column_id` is supplied and differs from the task's current column, it's
re-validated against the task's own `project_id` (same forged-id
defence as the POST route). Response: `{ task }`.

#### DELETE /api/board-tasks/[id]
Auth: session. Response: `{ ok: true }`. Soft-delete (`deleted_at`).

#### POST /api/projects/[id]/board/columns
Auth: session. Body: `{ name }`. Response: `{ column }` (201). `sort` =
server-computed `max(existing) + 1000`, so a manually-added column
always lands to the right of the existing set.

#### PATCH /api/board-columns/[id]
Auth: session. Body: `{ name?, sort? }`. Response: `{ column }`.
Renaming is the whole point of "per-project editable columns" — cards
only ever store `column_id`, never a denormalised column name, so a
rename is instant everywhere without touching a single task row.

#### DELETE /api/board-columns/[id]
Auth: session. Response: `{ ok: true }` or 400 `"This column still has
cards — move or remove them first."`. **Hard** delete, but ONLY when the
column has zero non-deleted tasks (BUILD-SPEC.md detailed scope: "delete
only when empty") — checked server-side before the delete runs, not
merely disabled in the UI. `board_tasks.column_id` is `on delete
cascade` at the DB layer (so a forced delete of a non-empty column is
technically possible via direct SQL), but this route deliberately
refuses rather than ever silently cascading away cards through the API.

### Procurement board — no new routes

BUILD-SPEC.md "Procurement board": "kanban VIEW over existing items ...
drag to change status (same PATCH, triggers existing Monday sync/date
stamps)". `components/items/ProcurementBoardView.tsx` drags a card
between status columns by calling the exact same `onPatch` callback
`ProjectWorkspace.tsx` already wires to `PATCH /api/items/[id]` for the
Spec and Pricing & Procurement views — there is no new write path, and
the existing fire-and-forget Monday sync on a transition to `"Ordered"`
(see this file's `PATCH /api/items/[id]` entry above) fires identically
regardless of which view triggered the status change. This view never
requests or renders `price_rrp`/`price_trade`/`markup_pct`/any computed
total — the parent `ProjectWorkspace` already holds the full `Item[]`
in memory (fetched via the Overview/FF&E tab's existing item query), so
no new GET route was needed for this lens either.

### Gantt (schedule phases)

#### GET /api/projects/[id]/phases
Auth: session. Response: `{ phases: SchedulePhaseWithContact[] }`,
non-deleted, sorted, each annotated with a lightweight contact summary
(`{ id, company, contact_name }`, batched lookup).

#### POST /api/projects/[id]/phases
Auth: session. Body: `CreatePhaseInput` — `{ name (required), start_date
(required), end_date (required), color_key? ('sand'|'charcoal'|'teal'|
'amber', default 'sand'), contact_id?, notes? }`. Response: `{ phase }`
(201). `end_date >= start_date` is validated here (400, friendly
message) AND enforced by the DB check constraint
(`chk_schedule_phases_dates`, migration 013) as a second line of
defence. `sort` = server-computed `max(existing) + 1000`.

#### PATCH /api/phases/[id]
Auth: session. Body: `PatchPhaseInput` (partial). Validates
`color_key` enum and re-checks `end_date >= start_date` across the
**merged** result (existing row + patch) — so a partial update that only
moves `start_date` later can't silently produce an invalid range that
the DB constraint would otherwise reject with a raw, less-friendly
Postgres error. Response: `{ phase }`.

#### DELETE /api/phases/[id]
Auth: session. Response: `{ ok: true }`. Soft-delete (`deleted_at`).

#### Portal mirror — no new route
BUILD-SPEC.md "Portal mirror": read-only, rendered directly in
`app/portal/[token]/page.tsx`'s existing service-role query block (same
pattern as every other portal section — Documents, Variations, Progress
photos). The query is an explicit column whitelist —
`select("id,name,start_date,end_date,color_key")` — that never fetches
`contact_id` or `notes` in the first place (not merely hidden by the
component), satisfying "phase names + bars + date ranges ONLY (no
contacts, no notes)" at the query layer. Covered by the same
token-gate + rate-limit + `noindex` that gates the whole portal page —
no separate rate-limit call needed. Renders nothing (the section
returns `null`) if the project has zero phases.

### Sort scheme (board_tasks, board_columns, schedule_phases)

All three tables use the same integer-ladder scheme: siblings get
`sort` values 1000 apart (`0, 1000, 2000, ...`). A new row via POST
lands at `max(existing) + 1000` — appended at the end without touching
any other row. A drag-drop reorder (`PATCH /api/board-tasks/[id]` with
`column_id`/`sort`) computes the new `sort` as the **midpoint** between
the row's new neighbours (`Math.round((before.sort + after.sort) / 2)`,
or `± 1000` past the end if dropped first/last in a column) — see
`components/board/ProjectBoard.tsx`'s `onDrop()`. This means a typical
reorder only ever writes to the ONE row being moved, never renumbers
every card in a column. If two adjacent integers are ever exhausted
(many reorders landing in exactly the same spot over time), the
midpoint calculation falls back to `before.sort + 1` — a tie is
harmless (no uniqueness constraint on `sort`), and the next full page
reload re-derives array order from the tied values' relative position
in the query's `order("sort")` result, which self-heals the gap over
time without requiring a dedicated renumbering job.

### Schema reference (migration `013_boards_contacts.sql`)

- `contacts(id, company, contact_name?, phone?, email?, website?,
  specialty?, category?, notes?, created_by?, created_at, updated_at,
  deleted_at?)` — indexes on `category`, `company`, `deleted_at`.
- `cost_lines.contact_id uuid references contacts(id) on delete set null` (additive)
- `items.supplier_contact_id uuid references contacts(id) on delete set null` (additive)
- `board_columns(id, project_id, name, sort, created_at, updated_at)`
- `board_tasks(id, project_id, column_id references board_columns(id) on
  delete cascade, title, description?, assignee_id references
  profiles(id) on delete set null, contact_id references contacts(id) on
  delete set null, due_date?, sort, created_by?, created_at, updated_at,
  deleted_at?)`
- `schedule_phases(id, project_id, name, start_date, end_date, color_key
  ('sand'|'charcoal'|'teal'|'amber', default 'sand'), contact_id
  references contacts(id) on delete set null, sort, notes?, created_at,
  updated_at, deleted_at?)` — check constraint `end_date >= start_date`.
- RLS: `team_all` (permissive, `authenticated`) on all four new tables —
  same Phase 1 shape as every non-financial, non-append-only table in
  this schema. No admin-gating requirement at the RLS layer; the one
  piece of API-layer enforcement this week is "delete column only when
  empty" (`DELETE /api/board-columns/[id]`).

### Seed data

`supabase/seed_contacts.sql` — parsed from
`docs-address-book-export.txt` (Monday.com export, pdftotext) by
`scripts/parse_address_book.py`. 109 companies across 30 categories (see
that script's docstring for the exact parsing rules). Idempotent —
guarded by a `where not exists (... same company + category ...)` check
per row, safe to re-run. Ambiguous rows (a phone number mislabelled as a
contact name; a company name that repeats verbatim under the same
category elsewhere in the source) are flagged `notes = 'Imported —
verify'`.

---

## Leads pipeline — Week 10 (admin-only, financial-adjacent)

BUILD-SPEC.md "Week 10 — Leads pipeline + Aria API layer": the native
`leads` table is the source of truth after a **one-time** Monday import
(`scripts/import-monday-leads.mjs`) — there is no ongoing/live sync, and
no route here ever reads Monday state back. Every route below is
**admin** (whole-route 403 before any query runs, same shape as
Invoices/Estimate) — leads are explicitly "admin-only, financial-adjacent"
per the build spec. All routes are **Aria-relevant** — this is the
feature set her lead-monitor, nurturer, and site-brief automations are
built around (see `docs/ARIA.md`).

### GET /api/leads
Auth: admin. Query: `?stage=` (exact match, one of the 10 pipeline
stages), `?q=` (search across surname_project/first_name/location/
email/phone), `?since=` (ISO timestamp — only leads created at/after
this time; this is exactly what a lead-monitor automation should poll),
`?summary=1` (also returns a `summary: LeadsDashboardSummary` block —
`{ total_pipeline_value, stages: [{ stage, count, value,
avg_days_in_stage }] }` — computed over the WHOLE pipeline, independent
of any `?stage`/`?q` filter applied to the `leads` array itself, so the
dashboard strip never appears to change just because the list below it
is filtered), `?limit=`/`?offset=` (Phase 14A pagination — default 500,
max 2000; response also carries `total`/`limit`/`offset`; NEVER applied
to the `?summary=1` whole-pipeline aggregate, only to the `leads` array
itself). Response: `{ leads: Lead[] }` or `{ leads, summary }`.
Non-deleted only, newest-updated first. **Aria-relevant** (`list_leads`
MCP tool).

### POST /api/leads
Auth: admin. Body: `CreateLeadInput` — `{ surname_project (required),
first_name?, source? ('META'|'DIRECT'), stage? (defaults 'Potential
Lead'), email?, phone?, location?, received_at? (defaults now), follow_up_date?,
site_visit_date?, site_visit_location?, construction_value?, design_value?,
design_start?, design_end?, construction_start?, construction_end?, notes? }`.
Response: `{ lead }` (201). This is for natively-created leads — the
one-time Monday import writes directly via the service-role client in
`scripts/import-monday-leads.mjs`, not through this route.

### GET /api/leads/[id]
Auth: admin. Response: `{ lead }`.

### PATCH /api/leads/[id]
Auth: admin. Body: `PatchLeadInput` (partial, whitelist only) — every
field including `stage` (though the documented path for a stage change
is the dedicated `POST /api/leads/[id]/stage` below; a plain PATCH that
happens to include `stage` still correctly logs a `lead_stage_events`
row, since that's a DB trigger, not API-layer logic — see migration
`014_leads.sql`). Empty strings become `null`, same convention as
`PATCH /api/contacts/[id]`. `surname_project` must stay non-empty if
included. Response: `{ lead }`.

### DELETE /api/leads/[id]
Auth: admin. Response: `{ ok: true }`. **Soft**-delete (`deleted_at`) —
a lead may be linked to a project (`leads.project_id` /
`projects.lead_id`), so this keeps the reference resolvable.

### POST /api/leads/[id]/stage
Auth: admin. Body: `{ stage }` (one of the 10 pipeline stages). The
single documented path for a stage change — used by the kanban board's
drag-drop and by Aria. Writes a plain `update({ stage })`; the
`lead_stage_events` row is written by the `trg_leads_stage_change` DB
trigger, not by this route directly, so there is exactly one writer of
that table (no risk of a double-write if a future call site also tries
to log the event). Response: `{ lead, events: LeadStageEvent[] }` — the
lead's full stage-change history is included in the same response so a
UI refreshing after a move doesn't need a second round-trip.
**Aria-relevant** (`move_lead_stage` MCP tool).

### GET /api/leads/[id]/history
Auth: admin. Response: `{ events: LeadStageEvent[] }`, newest first.
Same data `POST .../stage` returns inline, but independently fetchable
for the detail panel's stage-history timeline on open/refresh.

### POST /api/leads/intake
Auth: **bearer secret**, not a session — `Authorization: Bearer
$LEAD_INTAKE_SECRET` (same value the website's Vercel project holds as
`CRM_WEBHOOK_SECRET`; see `.env.local.example` and
`RESLU-Spec-Lead-Intake.md`). Fail-closed: env var unset → 503 for
every request. Rate-limited per client IP (10/min, in-memory,
best-effort). The website enquiry webhook — reslu.com.au /begin's
Vercel function POSTs every enquiry here.

Body (JSON, shape fixed by the website handoff spec): `{ type: "lead",
source, received_at, first_name, last_name, email, phone, project_type,
suburb, message, page, gclid, utm_source, utm_medium, utm_campaign,
utm_content, photos? }`. `type !== "lead"` or missing/invalid `email`
→ 400.

Creates one lead: stage `'Potential Lead'`, source `'WEBSITE'`,
`surname_project` = `Surname_ProjectType` (fallbacks: first name /
email local part; `"Enquiry"` when no project type). **`gclid` and the
four `utm_*` fields are stored verbatim on the lead (migration 042) —
MUST-KEEP: Aria's offline conversion import matches booked studio
visits back to the ad click via `gclid`.** `message` additionally
lands in the `lead_notes` feed as author "Website enquiry" so it's
visible in the detail panel.

`photos` (max 3, `[{ filename, content }]`, content = base64 JPEG,
data-URL prefix tolerated): each is magic-byte validated
(`lib/file-sniff.ts`), capped at 2 MB decoded, uploaded to the private
assets bucket under `leads/<id>/intake/…`, and recorded as a
`lead_attachments` row. A bad photo never fails the lead — it's
skipped and reported. Response 201: `{ ok, lead_id, photos_stored,
photo_errors? }`.

### GET /api/leads/[id]/attachments
Auth: admin. Files stored on a lead (today: intake photos from the
/begin form). Response: `{ attachments: (LeadAttachment & { url })[] }`
— `url` is a short-TTL signed URL minted per request from the private
assets bucket (never a public URL). Rendered by
`components/leads/LeadAttachments.tsx` as a read-only photo strip in
the lead detail panel.

### POST /api/leads/[id]/create-project
Auth: admin. Body: `{ standard_item_ids? }` (previously no body at
all — see "Standard spec items" below). BUILD-SPEC.md: "Moving a lead
to Design Work In Progress offers one-click 'Create project' (links
lead -> project)." **Phase 11 extension (5 July 2026):** UI label
renamed **"Progress to job"** in `components/leads/LeadDetailPanel.tsx`
— this route path is unchanged. The button is now surfaced whenever the
lead's stage is `'Design Work In Progress'`, `'Construction In
Progress'`, or `'Complete'` (previously only right after a stage change
into 'Design Work In Progress'), so older leads already further along
can still be progressed to a job.

**Standard spec items (migration `030_standards_lead_notes.sql`):**
same `standard_item_ids?` field and shared copy helper
(`lib/library-items.ts` `copyStandardItems()`/`copyLibraryItemToProject()`)
as `POST /api/projects` — see that route's own doc comment above for
the full behaviour. Only runs on the fresh-create path below, never on
the idempotent early-return (re-clicking "Progress to job" after a
refresh never re-copies items onto an already-existing project).
`components/leads/LeadDetailPanel.tsx` shows the same compact checklist
(`StandardItemsChecklist`) right above the "Progress to job" button.

Creates a project prepopulated from the lead:
- `name` <- `leads.surname_project` (unchanged, whole string incl. any descriptor)
- `client_name` <- `leads.first_name` + the **surname extracted** from
  `surname_project` (see "Name-split heuristic" below) — or just the
  extracted surname if no first name is on file
- `client_email` <- `leads.email`
- `client_phone` <- `leads.phone`
- `address` <- `leads.location`
- `budget` <- `leads.construction_value`

Sets `leads.project_id` and the new project's `lead_id` — linked both
ways (unchanged). Idempotent: if the lead already has a `project_id`
pointing at a project that still exists, returns that existing project
instead of creating a second one (safe to re-click after a page
refresh). Does not require the lead to currently be in any particular
stage — that's the UI's surfacing condition for the button, not a hard
rule enforced here. Response: `{ project, lead }` (201, or 200 if it
returned an existing project).

**Name-split heuristic** (`extractSurname()` in this route file):
`surname_project` is a free-text card title in the format `'Surname'`
or `'Surname — project descriptor'`. The function splits on the FIRST
occurrence of `' — '` (em-dash) or `' - '` (hyphen), both with
surrounding spaces, and takes everything before it, trimmed; if no
separator is found, the whole trimmed string is treated as the
surname. This fixes a Week 10 behaviour where `client_name` was built
from `first_name` + the WHOLE `surname_project` string (producing
names like "Jane Smith — Kitchen Reno"); it now reads "Jane Smith".
Best-effort by design — `surname_project` is not a structured name
field.

### GET /api/leads/attention
Auth: admin. Response: `LeadsAttentionResponse` — `{ nurture: Lead[],
stale_proposals: Lead[], follow_ups_due: Lead[], site_visits_upcoming:
Lead[] }`. BUILD-SPEC.md "Needs-attention panel": `nurture` = stage
'Proposal Sent' for >=4 days (measured from the most recent
`lead_stage_events` row moving the lead INTO its current stage, falling
back to `received_at` then `created_at` if no such event exists);
`stale_proposals` = stage 'Awaiting to Send Proposal' for >=7 days
(same measurement); `follow_ups_due` = `follow_up_date` <= today;
`site_visits_upcoming` = `site_visit_date` within the next 7 days. A
lead can legitimately appear in more than one group at once — this is
not deduplicated, since e.g. a 'Proposal Sent' lead whose follow-up is
also overdue genuinely needs both signals surfaced. This is **the**
route BUILD-SPEC's "Aria API layer" names for her nurturer/monitor
automations to poll (see `docs/ARIA.md`). **Aria-relevant**
(`get_needs_attention` MCP tool).

### GET /api/leads/[id]/notes
Auth: admin (migration `030_standards_lead_notes.sql`). Body: none.
Response: `{ notes: LeadNote[] }` — **newest first** (contrast with
`GET /api/items/[id]/notes`, which is oldest first; the lead notes feed
is explicitly newest-first per this round's spec so a freshly-added
note is immediately visible without scrolling). Otherwise a structural
mirror of the item-notes route: same `{ id, lead_id, author_id,
author_name, text, created_at }` shape (`LeadNote`, `types/round-d.ts`)
against `lead_notes` instead of `item_notes`.

### POST /api/leads/[id]/notes
Auth: admin. Body: `{ text }` (required, trimmed). Response: `{ note }`
(201). `author_name` denormalised from the caller's profile full name,
falling back to email, then `"Team member"` — byte-for-byte the same
fallback chain as `POST /api/items/[id]/notes`. Replaces
`leads.notes` as the editable notes surface —
`components/leads/LeadDetailPanel.tsx` no longer offers the old
free-text field; `components/leads/LeadNotes.tsx` (feed + composer) is
the only UI writer of this table now. **Aria-relevant**
(`add_lead_note` MCP tool — e.g. logging the outcome of a call or
email; see `docs/ARIA.md`).

**Data migration (one-time, in `030_standards_lead_notes.sql` itself):**
every lead with a non-empty legacy `leads.notes` value got exactly one
`lead_notes` row inserted — `author_name = 'Imported note'`,
`author_id = null`, `text = ` the old `leads.notes` value verbatim,
`created_at = leads.created_at`. Idempotent (guarded by a `NOT EXISTS`
check on `(lead_id, author_name = 'Imported note')`), so re-running the
migration never duplicates the import. `leads.notes` itself is **not**
dropped — it just stops being written to by the app from this round
on; still readable directly against the table if ever needed.

### Schema reference (migration `014_leads.sql`)

- `leads(id, surname_project, first_name?, source? ('META'|'DIRECT'),
  stage (10-value check constraint, default 'Potential Lead'), email?,
  phone?, location?, received_at?, follow_up_date?, site_visit_date?,
  site_visit_location?, construction_value?, design_value?,
  design_start?, design_end?, construction_start?, construction_end?,
  monday_item_id? (unique — import provenance), notes?, project_id?
  (references projects(id) on delete set null), created_by?, created_at,
  updated_at, deleted_at?)` — indexes on `stage`, `follow_up_date`,
  `deleted_at`, `project_id`.
- `lead_stage_events(id, lead_id, from_stage?, to_stage, at)` —
  append-only (insert + select RLS only, no update/delete policy, same
  shape as `signature_events`); populated exclusively by the
  `trg_leads_stage_change` trigger on `leads` UPDATE, never by direct
  API-layer inserts.
- `projects.lead_id uuid references leads(id) on delete set null`
  (additive) — the reverse link for "Create project".
- RLS: `team_all` (permissive, `authenticated`) on both new tables, same
  Phase 1 shape as every other table in this schema (see that
  migration's own extended comment on why admin enforcement for leads
  is done exclusively in the API layer, consistent with how Invoices/
  Estimate are already gated, rather than introducing the first-ever
  RLS role check in this codebase for one table).

---

## Portal (client-facing, token-based — not session auth)

### POST /api/portal/[token]/[action]/[itemId]
Auth: **portal-token** — no session; `token` is looked up against
`projects.client_token` via a service-role client (bypasses RLS); no
expiry check exists on the token. `action` restricted to
`"approve" | "flag"` (anything else → 404). Body: `{ note?: string }`.
Response: `{ item }` via an explicit `PORTAL_FIELDS` whitelist (id,
item_code, name, description, supplier, quantity, location, status,
selected_image_url, client_approved, client_flagged, client_flag_note)
— never any pricing. Rate-limited 30 requests/60s per token+IP (429 +
`Retry-After` header on breach). Writes an `approval_events` audit row
and fire-and-forget queues a digest email (`void recordPortalAction(...)`,
never blocks the response). **Not available to Aria** — BUILD-SPEC.md
"Safety rails": approve/flag is client-portal-only.

---

## Digest

### GET /api/digest/flush
Auth: header `authorization: Bearer ${CRON_SECRET}` only (401
otherwise — no session path for GET). This is Vercel Cron's actual
entry point: `vercel.json`'s `crons` entry calls this at fixed UTC
times chosen to land on 9am/12pm/4pm Adelaide time in both DST states
(Vercel Cron is UTC-only and can't express `Australia/Adelaide`
directly); the handler itself re-checks the current Adelaide hour and
only flushes on those three slots, returning `{ skipped: "..." }`
harmlessly on every other invocation. Uses the service-role client (no
user session exists on a scheduled call).

### POST /api/digest/flush
Auth: session (not admin-gated) **or** the same
`authorization: Bearer ${CRON_SECRET}` header. Body: none. Response:
passthrough of `flushDigest()`'s result. Sends any pending
`portal_digest_queue` rows, grouped per project, to admin profiles,
then marks them `sent_at`. This is the manual "Send digest" trigger
(any signed-in team member, any time) — Vercel's own Cron calls the GET
handler above, not this one; this POST path also accepts the
CRON_SECRET header for any other external scheduler that prefers POST.
The cron path uses a service-role Supabase client (no user session
exists on a scheduled call) — see the route's doc comment for the
reasoning.

---

## Monday.com sync

### GET /api/monday/boards
Auth: session. Body: none. Response: passthrough of `listBoards()`,
cached `private, max-age=60`. Note: on internal failure this still
returns **HTTP 200** with `{ configured: true, boards: [], error }` —
check the `error` key, don't rely on status code.

### POST /api/monday/sync/[itemId]
Auth: session. Body: none. Response: `{ skipped }` or
`{ monday_item_id }` (also persisted onto the item along with
`monday_synced_at`); 404 if the item isn't found; 502 on sync failure.
This is the manual/retry counterpart to the automatic fire-and-forget
sync that fires from `PATCH /api/items/[id]` when `status` transitions
to `"Ordered"` — unlike that path, failures here ARE surfaced to the
caller.

---

## Profiles (roles)

### PATCH /api/profiles/[id]
Auth: admin. Body: `{ role: "admin" | "designer" | "viewer" }`.
Response: `{ profile }`. Refuses to demote the last remaining admin
(400 `"Cannot demote yourself — you are the last remaining admin."`).

---

## Search

### GET /api/search
Auth: session. Body: none. Query: `?q=` (empty result if missing or
under 2 characters). Response: `{ projects: [], items: [], library: [] }`
from three parallel queries (limits 10/20/20). Note: library results
here are **not** run through the same financial-field stripping as
`GET /api/library` — currently safe only because the selected columns
happen to exclude pricing, not because a shared guard enforces it. If
this route's library select ever grows a `price_trade`-adjacent
column, it would leak to non-admins undetected. Worth hardening with
an explicit column whitelist or the same `stripFinancials()` helper if
this route's scope grows.

---

## Trade visits & timeline v2 (Phase 11A)

Migration `015_trade_visits.sql`: new table `trade_visits`; `schedule_phases`
gains `kind` (`'phase'|'umbrella'`, default `'phase'`) and `cost_section_id`
(nullable FK to `cost_sections`, `on delete set null`). See that
migration's own doc comments for the full design rationale (why
`contact_id` stays nullable, why `confirm_token`'s default mirrors
`projects.client_token`, why status/proposed_* are separate columns
rather than jsonb).

### GET /api/projects/[id]/phases (extended)
Auth: session. Response now: `{ phases: SchedulePhaseWithVisits[] }` —
each phase carries `kind`, `cost_section_id`, and a batched-fetch
`visits: TradeVisitWithContact[]` (non-deleted, each with a lightweight
contact summary). Before returning, this route performs **umbrella
recompute-on-read**: it looks up a `cost_sections` row named
(case-insensitively) "Preliminaries & Site" with at least one live
`cost_lines` row; if found, it upserts a `kind='umbrella'` phase named
"Site Setup" whose `start_date`/`end_date` are recomputed to
`min(start)`/`max(end)` across every ordinary `kind='phase'` row
(`lib/trade-visits.ts`'s `computeUmbrellaBand`); if not found (or the
section has zero live lines), any existing umbrella phase is
soft-deleted. Tradeoff: the umbrella band is only as fresh as the last
GET — accepted to avoid coupling this file to the estimate module
(`app/api/estimate/**`), which this feature does not own. The umbrella
phase also carries `cost_section_lines: string[]` — line
**descriptions only**, no cost/pricing fields.

### POST /api/projects/[id]/phases (extended)
`kind` is never accepted from the client — every phase created here is
`kind='phase'` (the DB default). Umbrella phases are exclusively
system-maintained via the GET recompute-on-read logic above; there is
no client-facing way to create one directly.

### PATCH /api/phases/[id] (extended)
`kind` and `cost_section_id` are silently stripped from the update
(never in `EDITABLE_FIELDS`). If the target phase is `kind='umbrella'`,
any attempt to touch `name`/`start_date`/`end_date` 400s ("Umbrella
phase dates and name are system-managed and cannot be edited
directly.") — those fields are recomputed on every GET, so a direct
edit would either be silently clobbered or fight the recompute logic.
Other fields (`color_key`, `contact_id`, `notes`, `sort`) remain
editable on an umbrella phase.

### DELETE /api/phases/[id] (unchanged behaviour, note added)
Deleting an umbrella phase directly is allowed — no special-case block.
It carries no team-authored content of its own (dates are
system-derived, `cost_section_lines` are read live from `cost_lines`),
so deleting it is at worst a no-op until the next
`GET /api/projects/[id]/phases` recreates it.

### POST /api/projects/[id]/visits
Auth: session, no admin gate (scheduling data, not financial). Body:
`CreateVisitInput` — `{ phase_id, contact_id?, start_date, end_date,
arrival_slot? ('first_thing'|'midday'|'afternoon'), arrival_time?,
notes? }`. Validates: phase exists under this project and is NOT
`kind='umbrella'` (400 "Cannot add visits to the Site Setup umbrella
phase"), contact (if given) exists, `end_date >= start_date`,
`arrival_slot` enum. Inserts with `status='unconfirmed'`;
`confirm_token` is a DB default, never client-supplied. Response:
`{ visit }` (201).

### PATCH /api/visits/[id]
Auth: session. Body: `PatchVisitInput` (partial) — `contact_id`,
`start_date`, `end_date`, `arrival_slot`, `arrival_time`, `notes` only.
`status`/`confirm_token`/`confirmed_at`/`confirmed_by`/`proposed_*`/
`reminder_sent_at` are silently stripped (not in `EDITABLE_FIELDS`) —
those are managed exclusively via `/confirm`, `/resolve-proposal`, and
the public `/api/trade/[token]/respond` route. Rejects (400) if the
visit's parent phase is `kind='umbrella'` (defensive — structurally
should never happen, since umbrella phases can never receive visits at
creation). Response: `{ visit }`.

### DELETE /api/visits/[id]
Auth: session. Soft-delete (`deleted_at`). Response: `{ ok: true }`.

### POST /api/visits/[id]/confirm
Auth: session, no admin gate. Staff "confirm on behalf of trade" — no
body. Sets `status='confirmed'`, `confirmed_at=now()`,
`confirmed_by='staff'`. Response: `{ visit }`. Used from the mobile
bottom sheet and the phase edit panel's per-visit row.

### POST /api/visits/[id]/resolve-proposal
Auth: session, no admin gate. Body: `{ action: 'accept' }` or
`{ action: 'counter', start_date, end_date, arrival_slot?,
arrival_time?, note? }`. 400 unless `visit.status === 'proposed_change'`.
`accept`: copies `proposed_*` onto the live fields, clears `proposed_*`,
sets `status='confirmed'`, `confirmed_by='staff'`; if the visit's
contact has an email and Gmail is configured, sends a confirmation
email with a link back to `/trade/[confirm_token]` — wrapped in
try/catch, a send failure is logged (`console.error`) but does NOT fail
the request (fire-and-forget, same "DB write is the source of truth"
pattern used elsewhere in this codebase). `counter`: overwrites
`proposed_*` with the staff's own counter-proposal; `status` **stays**
`'proposed_change'` (the trade sees the new proposed date next time
they open their link) — sends a different-copy email, same fail-open
behaviour. Response: `{ visit }`.

### GET /api/visits/attention
Auth: session, **no admin gate** — a deliberate deviation from
`GET /api/leads/attention`'s admin gate, since trade-visit scheduling
data carries no financial values (unlike leads' pipeline value).
Response: `{ proposed_pending: [...], starting_soon: [...] }` from
`lib/trade-visits.ts`'s `computeVisitAttention` — `proposed_pending` is
every non-deleted visit with `status='proposed_change'`;
`starting_soon` is every non-deleted `unconfirmed`/`tentative` visit
whose `start_date` is within `[today, today+3]` inclusive. Each visit
is annotated with `phase_name`, `project_name`, and a lightweight
`contact` summary (batched, not N+1).

### GET /trade/[token] (page, not an API route)
Public, unauthenticated. Same trust model as `/portal/[token]`:
`trade_visits.confirm_token` (32-byte hex, same generation expression
as `projects.client_token`) is the security boundary. Rate-limited by
IP (`rateLimit(\`trade-page:\${token}:\${clientIp}\`)`), `noindex`,
service-role client. Expired (deleted, or `today > end_date`) renders
an `ExpiredNotice` in-page rather than `notFound()`, so a trade with a
stale link still sees a polite message instead of a bare 404. Shows
nominated day(s)/arrival (`formatArrival()`), a "who else is on site"
list (company + status only, `confirmed`/`tentative` visits overlapping
the subject visit's covered week(s) — see `lib/trade-visits.ts`'s
`findOverlappingVisits` for the exact overlap definition used), and the
three response actions below. **No contact phone/email of ANY trade
(self or other) is ever included in this page's data or render path.**

**Middleware note (corrected 8 July 2026):** `/trade` and `/api/trade`
are now present in `lib/supabase/middleware.ts`'s `isPublicPath`
allowlist (added since this doc note was first written) — no
on-machine follow-up is needed; both prefixes, including the "Trade
booking document pack" round's new
`/api/trade/[token]/documents/plans|schedule|sow` proxies below, are
correctly public today.

**"Trade booking document pack" round (8 July 2026):** when the
visit's `document_pack` is non-null (see migration
`032_visit_document_pack.sql` below), this page also renders a
DOCUMENTS section (`components/trade/TradeDocuments.tsx`) resolved
fresh on every load from the pack's frozen choices against the
project's CURRENT plans/schedule/SOW — see that migration's own
schema-reference entry and the three new proxy routes immediately
below for the full design.

### POST /api/trade/[token]/respond
Public, unauthenticated. Rate-limited tighter than the page
(`rateLimit(..., 10, 60_000)` — a mutation, not a read). Re-checks
token expiry independently of the page (so a direct POST against an
expired visit 410s even if the trade never loaded the page). Body,
dispatched on `action`:
- `'confirm'`: sets `status='confirmed'`, `confirmed_by='trade'`. If
  the visit has neither `arrival_slot` nor `arrival_time` already set,
  the body MUST supply one (400 "Please choose an arrival time before
  confirming." otherwise) — mirrored client-side by
  `components/trade/TradeRespondForm.tsx` forcing the picker open in
  that case.
- `'confirm_different_time'`: auto-accepted immediately (same-day, no
  staff approval needed) — sets `arrival_slot`/`arrival_time`,
  `status='confirmed'`, `confirmed_by='trade'`, and appends an FYI line
  to `notes` (`[Trade changed arrival time on <date>]`) rather than a
  new column.
- `'propose'`: sets `proposed_start`/`proposed_end`/`proposed_slot`/
  `proposed_time`/`proposed_note`, `status='proposed_change'`.
  Validates `proposed_end >= proposed_start`.

Response: `{ visit }` or `{ error }`.

### GET /api/trade/[token]/documents/plans
### GET /api/trade/[token]/documents/schedule
### GET /api/trade/[token]/documents/sow

"Trade booking document pack" round (8 July 2026) — three tokened proxy
routes powering the trade page's DOCUMENTS section, one per document
kind. All three share the same gating shape (each re-derived
independently, same discipline as `respond` above):

1. Rate-limited by token+IP (`trade-doc-plans`/`trade-doc-schedule`/
   `trade-doc-sow` buckets, default 30/min — a read, not a mutation).
2. `confirm_token` must resolve to a real, non-deleted `trade_visits`
   row (implicitly project-scoped: the row IS the one project this
   token belongs to).
3. `isVisitExpired()` re-checked independently of the page.
4. `document_pack` must have the corresponding choice actually ticked
   — `include_plans` / `schedule_categories` key present /
   `include_sow` — or the route 404s ("No plans/schedule/scope of
   works were included with this booking") even for an otherwise valid,
   unexpired visit. **This is the "only pack-selected docs reachable"
   guarantee** — a trade can never reach a document type their booking
   didn't offer, regardless of whether that document exists.

Each route then resolves the CURRENT live document fresh (never a
stored URL/id from booking time — see migration
`032_visit_document_pack.sql`'s "frozen choices, live revisions" note):

- **`.../documents/plans`** — finds the project's latest `project_files`
  row with `kind='plans'` (`lib/trade-doc-pack.ts`'s `latestPlansFile`,
  same newest-revision-first sort as `ProjectDocuments.tsx`), mints a
  fresh signed URL (`SIGNED_URL_TTL_SECONDS`, 1 hour) against the
  private `assets` bucket, and **redirects** to it (cheaper than
  proxying the bytes through this function). 404s if the pack ticked
  Plans but every revision has since been deleted.
- **`.../documents/schedule`** — renders the exact same spec-view
  schedule as `GET /api/projects/[id]/pdf` (byte-for-byte identical
  `PDF_ITEM_FIELDS` allowlist — **no pricing columns**, verified
  letter-for-letter against that route), filtered to the visit's frozen
  `schedule_categories`. Reuses that route's own PDF-cache Storage path
  (`pdf-cache/{projectId}/{hash}.pdf`) and cache-key shape (items
  `updated_at`/count + `job_number` + category set), so a schedule
  already rendered via the team-facing route or export dialog for the
  same category set is served from cache with no re-render. Streams
  the PDF bytes directly (`Content-Type: application/pdf`), not a
  redirect.
- **`.../documents/sow`** — renders the same branded SOW PDF as
  `GET /api/projects/[id]/sow/[sowId]/pdf`, for the project's latest
  **issued** `sow_documents` revision (`lib/trade-doc-pack.ts`'s
  `latestIssuedSow` — a draft-in-progress SOW is never served). No
  caching (matches the team-facing SOW route's own uncached behaviour).
  404s if the pack ticked SOW but no revision has ever been issued (or
  the only issued one was since soft-deleted).

Response: `200` with the PDF bytes (or a redirect, for plans) on
success; `404`/`410`/`429` with `{ error }` otherwise.

### GET /api/trade-reminders
Vercel Cron entry point, `vercel.json` schedule `"0 21 * * *"` (21:00
UTC = 07:30 ACST, Adelaide standard time, no DST correction attempted
— see the route's own doc comment for why a half-hour drift across
DST transitions is acceptable for a "day before" reminder, unlike the
digest cron's exact-hour requirement). Auth: `Bearer ${CRON_SECRET}`
**or** an authenticated team session (manual "run reminders now"
trigger) — mirrors `POST /api/digest/flush`'s `isCronCall` fallback
pattern. Finds non-deleted `trade_visits` with `status IN
('unconfirmed','tentative')`, `reminder_sent_at IS NULL`, and
`start_date` 1 or 2 days from today (server UTC date — a harmless
±1-day fuzz, contrasted with the digest cron's exact-hour need).
Sends a personalized reminder email per visit (nominated day/time, the
"who else is on site" list, a link to `/trade/[confirm_token]`) via
`lib/gmail/send.ts`'s `sendTeamEmail`. Only stamps `reminder_sent_at`
on an actual (non-skipped) send — a skip due to missing Gmail
configuration is retried on the next run, since it is not the same as
"already reminded". Each visit's send is wrapped in try/catch so one
failure doesn't abort the batch. Response: `{ sent, skipped, failed }`.
Invariant: an umbrella-kind phase can never have `trade_visits` rows
against it (enforced at `POST /api/projects/[id]/visits`), so this
query never needs to filter by phase kind.

### Schema reference (migration `015_trade_visits.sql`)

- `trade_visits(id, project_id, phase_id references schedule_phases(id)
  on delete cascade, contact_id references contacts(id) on delete set
  null, start_date, end_date, arrival_slot?, arrival_time?, status
  ('unconfirmed'|'confirmed'|'tentative'|'declined'|'proposed_change',
  default 'unconfirmed'), proposed_start?, proposed_end?, proposed_slot?,
  proposed_time?, proposed_note?, confirm_token (unique, default
  `encode(gen_random_bytes(32), 'hex')` — same expression as
  `projects.client_token`), confirmed_at?, confirmed_by?
  ('trade'|'staff'), reminder_sent_at?, notes?, created_by?, created_at,
  updated_at, deleted_at?)` — check constraint `end_date >= start_date`.
  Indexes: `project_id`, `phase_id`, `(status, start_date)`,
  `deleted_at`.
- `schedule_phases` gains `kind` (`'phase'|'umbrella'`, default
  `'phase'`) and `cost_section_id references cost_sections(id) on
  delete set null` (additive).
- RLS: `team_all` (permissive, `authenticated`) on `trade_visits` — the
  public `/trade/[token]` page and its respond route never use this
  policy; they go through the service-role client (bypasses RLS
  entirely), same trust model as the client portal.
- **Migration `032_visit_document_pack.sql`** (8 July 2026) adds
  `trade_visits.document_pack jsonb` (nullable, no RLS change — a new
  column on an already-permissive table): `{include_plans: boolean,
  schedule_categories?: string[]|null, include_sow: boolean}`. Column
  `null` = no pack configured (every pre-round visit). `schedule_categories`
  is a genuine three-state field — KEY ABSENT means the Schedule choice
  was unticked, `null` means "ticked, full schedule," a `string[]`
  means "ticked, filtered to these category prefixes" — see that
  migration's own comment and `types/trade-doc-pack.ts`'s
  `DocumentPackChoices` for the full rationale. Written by `BookVisitPanel.tsx`'s
  "Include documents" section, forwarded through
  `POST /api/board-tasks/[id]/book-visit`'s optional `document_pack`
  body field (frozen at booking time; an omitted field on a re-link
  never blanks out an existing pack). Read by the trade page's
  DOCUMENTS section and the three `.../documents/plans|schedule|sow`
  proxy routes above, always re-resolved against CURRENT live documents
  (never a stored file reference).

## Portal v2, diary, gallery & notifications (Phase 11B)

Restyled client portal, the internal site-photo gallery, the Aria
diary workflow, decision deadlines, the handover pack, and client-
facing email notifications. Migration `016_portal_v2.sql`.

### Portal page (`GET /portal/[token]`)

Unauthenticated, token-gated, rate-limited, `noindex`, service-role
client. Section order: **What's next** (derived-only banner, no nav
entry) -> **Selections** (was "Schedule & approvals") -> **Timeline**
(unchanged, owned by the Phase 11A agent's `TimelineSection.tsx`) ->
**Diary** (was "Updates", now magazine-style with 1-2 photos) ->
**Documents** (now includes `kind='certificate'` + inline "Signed"/
"Awaiting signature" badges) -> **Contracts & signatures** ->
**Variations** -> **Progress photos** (now reads published
`site_photos` UNION legacy `progress_photos`) -> **Handover** (only
rendered when `projects.status = 'completed'`).

Still never selects any pricing/ordering column on items; the one
deliberate exception remains variations' `cost_inc_gst` (computed
server-side, never `cost_ex_gst`).

### Selections (FF&E approvals at scale)

- `POST /api/portal/[token]/approve/[itemId]` / `.../flag/[itemId]` —
  unchanged from Week 3B/8B, now also returns `decision_needed_by` in
  the response item.
- `POST /api/portal/[token]/bulk-approve` — Body `{ location }`.
  Approves every item in that room that is NOT flagged and NOT already
  approved, in one call. Writes ONE `approval_events` row PER ITEM
  (never a single combined "bulk" event) with note `"Approved via
  'Approve all in room' (<location>)."`. Never touches flagged items —
  enforced twice: the candidate SELECT excludes `client_flagged=true`,
  and the UPDATE itself re-asserts `.eq("client_flagged", false)` as
  defence in depth against a race. Rate-limited per token+ip like every
  other portal route. Response: `{ approved_count, items }`.
- Client UI (`components/portal/SelectionsSection.tsx`): progress
  header + bar, filter chips (Awaiting/Flagged/Approved), room grouping
  with per-room "Approve all N" (confirm dialog first), and a
  full-screen "Review one by one" stepper
  (`components/portal/SelectionsStepper.tsx`) that only queues
  not-yet-decided items, with Approve/Flag/Skip and auto-advance
  ("N of M" progress).
- Deadline display: when `items.decision_needed_by` is set and the item
  isn't yet approved, the row shows "Approve by {date} to keep your
  design package on schedule" — amber once the date has passed.
  Construction dates are never mentioned (design-phase framing only,
  per BUILD-SPEC.md).

### Diary workflow

- `GET/POST /api/projects/[id]/client-updates/posts` — POST now accepts
  an optional `photo_ids: string[]` (linked via `portal_update_photos`,
  ownership-checked against the project first) and no longer requires
  non-empty `title`/`body_richtext` (a bare draft can be created with
  just photos attached, or completely empty as a placeholder). GET now
  returns each update's linked `photos` (signed URLs) and its
  `status`/`draft_source`.
- `PATCH /api/projects/[id]/client-updates/posts/[postId]` —
  `{ publish: true }` now also sets `status: 'published'` (previously
  only touched `published_at`); on a genuine FIRST publish it also (a)
  marks every linked `site_photos` row `published_to_portal = true`
  and (b) fires a client email notification (best-effort, see
  Notifications below). `{ publish: false }` resets `status: 'draft'`.
- `GET/POST /api/projects/[id]/client-updates/posts/[postId]/aria-draft`
  — Aria-facing (she authenticates as a normal team session per
  `docs/ARIA.md`, not service-role). GET fetches the draft's rough
  notes + linked photo captions (404s unless `status = 'draft'`). POST
  `{ title, body_richtext }` saves her polished copy onto the SAME row,
  setting `draft_source: 'aria'`, `status: 'pending_approval'` (404s
  unless the row is still `status = 'draft'` — she can't overwrite an
  already-submitted or already-published entry). Publishing is a
  SEPARATE, human, one-tap action via the PATCH route above — this
  route never sets `published_at`.
- `GET /api/projects/[id]/client-updates/summary` — `updates` now
  includes `body_richtext`, `status`, `draft_source`, and each entry's
  linked `photos` (signed URLs), feeding the client-area Diary panel's
  initial render.
- Team UI: `components/client-area/DiaryPanel.tsx` — phone-first
  composer (photo picker first, one large rough-notes textarea, one
  "Send to Aria" button), a "Ready to publish" section showing
  `DiaryApprovalCard` (polished preview, single-tap Publish, inline
  Edit), a "Drafts awaiting Aria" list, and a Published list with
  Unpublish/Remove. `DiaryApprovalCard` is exported standalone so the
  project overview hub (outside this agent's boundary) can reuse it —
  see this task's boundary notes.

### Site gallery (internal)

- `GET/POST /api/projects/[id]/site-photos` — team-authenticated. GET
  lists all staged photos (published + unpublished), signed URLs, newest
  `taken_at` first. POST — multipart, multiple `files[]` + optional
  `caption`/`taken_at`, mirrors the existing `progress_photos` upload
  route's shape exactly, writing to `site_photos` instead. Client-side
  compression (canvas, max 2000px longest edge, JPEG q=0.85, no deps —
  `components/gallery/compress.ts`) happens BEFORE the multipart POST;
  the route itself does not re-compress.
- `PATCH/DELETE /api/site-photos/[id]` — team-authenticated. PATCH any
  subset of `{ caption, published_to_portal, in_handover_pack,
  taken_at }`. DELETE soft-deletes (`deleted_at`).
- UI: `/projects/[id]/gallery` (linked from `ProjectTabs`) —
  `GalleryUploader` (two actions: "Take photo" = `<input capture=
  "environment">` camera-direct, "Upload" = multi-select library
  picker), `GalleryGrid` (grouped by `taken_at` date, inline caption
  edit, per-photo publish toggle, multi-select mode), and "Add to diary
  draft" (creates a bare draft via the posts route with the selected
  photo ids, then redirects to `/projects/[id]/client?tab=diary`).

### Handover pack

- `GET/PATCH /api/projects/[id]/handover` — team-authenticated. GET
  returns curation candidates across three tables: `project_files`
  (`kind='certificate'` OR already `share_to_portal`), `item_files`
  (`kind IN ('install_manual','warranty')`, ownership-checked via an
  `items!inner(project_id)` filtered embed), and `site_photos` (all,
  not deleted). PATCH body `{ table, id, in_handover_pack }` toggles one
  row, re-verifying project ownership for every table before writing.
- UI: `components/client-area/HandoverCurationPanel.tsx`, a new
  "Handover pack" tab in the team client area — plain tick-lists, no
  new page.
- Portal: the Handover section only renders when `projects.status =
  'completed'`, built server-side by `buildHandoverPack()` in
  `app/portal/[token]/page.tsx` from the same three tables' `
  in_handover_pack = true` rows.

### Client email notifications

`lib/notify-client.ts` — `notifyClient()` / `notifyClientBatch()`.
No-op (never throws) when Gmail is unconfigured, the project has no
`client_email`, `notify_client` is off, or the event list is empty.
Sends ONE email per request cycle covering however many
notification-worthy events fired in that cycle (see the file's doc
comment for why this is request-cycle batching rather than a true
cross-request time-window batch). Wired into: diary first-publish
(`.../posts/[postId]` PATCH), document share-to-portal turning ON
(`.../files/[fileId]/share` PATCH), variation share-to-portal turning
ON (`.../variations/[variationId]/share` PATCH), and — **Phase 11
extension, 5 July 2026** — signature request creation
(`POST /api/signatures`, `trigger: "signature_requested"`, `section:
"contracts"`; see that route's entry above). This closes the "NOT
wired" gap this section previously documented.

**Phase 11 extension — dual recipients:** `notifyClientBatch()` now
sends to BOTH `projects.client_email` and `projects.
client_secondary_email` (migration `017_project_contacts.sql`) in ONE
email's `to` list, when the secondary is set — not two separate sends.
`lib/gmail/send.ts`'s `sendTeamEmail({ to: string[] })` already accepts
multiple recipients on a single message, so this needed no transport
change; only the `ProjectRow` select + a `.filter(Boolean)` on the `to`
array in `notifyClientBatch()`. `client_email` (primary) remains the
sole gate for whether a notification fires at all.

### Decision deadlines

`items.decision_needed_by` (nullable date, migration 016) — portal
approve/bulk-approve responses already include it, and the Selections
UI already renders the "Approve by {date}" copy when it's set.

**Closed in Phase 11 extension (5 July 2026):** `decision_needed_by` is
now in `PATCH /api/items/[id]`'s `EDITABLE_FIELDS` (see that route's
entry above) and has a write surface — a native date input labelled
"Client decision needed by" in `components/items/SpecRegister.tsx`'s
expanded item row, next to Status, using the same single-save-per-field
pattern as every other field there. Staff can now actually set a
deadline; previously the column existed and was read/rendered
everywhere on the portal side but nothing populated it.

## Owner contact details — Phase 11 extension (5 July 2026)

Migration `017_project_contacts.sql`. Phillip's build note: "Owner
contact details on projects" — projects can have two owners (couples).

### Schema reference (migration `017_project_contacts.sql`)

- `projects` gains (all nullable text, no format validation, same as
  the existing `client_email`): `client_phone`, `client_secondary_name`,
  `client_secondary_email`, `client_secondary_phone`. No
  `client_secondary_...` "primary" counterpart column is added for the
  first owner's name — `client_name` (migration `001_initial.sql`)
  already is the primary owner's name.

### Settings form

`components/settings/ProjectSettingsForm.tsx` gains a "Client contacts"
group (see `PUT /api/projects/[id]`'s entry above for the field list) —
primary email/phone, a notify-client checkbox, and an optional "Second
owner" name/email/phone sub-group. All fields disabled (not hidden) for
non-admins, matching every other field on this form. A caption note
appears under the second owner's email once filled in: "Both owners
will be copied on the same email notification."

### Leads → job handoff

See `POST /api/leads/[id]/create-project`'s entry above (UI relabel to
"Progress to job", widened surfacing stages, prepopulated
client_email/client_phone/budget, and the name-split heuristic).

### Integration debts closed

- `decision_needed_by` write path — see `PATCH /api/items/[id]`'s entry
  above and "Decision deadlines" above.
- Signature-request client notification — see `POST /api/signatures`'s
  entry above and "Client email notifications" above.

## Estimate versioning + VM comparison — Phase 12a-A (admin-only, financial)

BUILD-SPEC.md "Phase 12a — My Work + estimate versioning with VM".
Every route below is whole-route **admin**-gated, same shape as the
rest of the Estimate module (403 before any query runs for a
non-admin).

### GET /api/projects/[id]/versions
Auth: admin. Body: none. Response: `{ versions: EstimateVersionSummary[] }`
— every version for the project, newest first. **Omits `snapshot`**
(can be a large jsonb blob) — fetch `GET /api/versions/[id]` for the
full frozen estimate.

### POST /api/projects/[id]/versions
Auth: admin. Body: `{ label, kind?, note? }` (`kind ∈ issue | vm`,
defaults `'issue'`). Response: `{ version }` (201). "Save version" —
freezes the project's CURRENT live estimate state (sections/lines, FF&E
rollup, whole-job totals, markup %, every measurement, and the latest
SOW revision label) into a new `estimate_versions` row. `label` must be
unique per project — 409 on collision with a clear message.

### GET /api/versions/[id]
Auth: admin. Body: none. Response: `{ version }` — one version WITH
its full `snapshot` (the read-only version viewer's data source). Not
nested under `/api/projects/[id]/...` since a version id is already
globally unique, mirroring `app/api/estimate/lines/[id]`'s pattern for
singular child resources.

### DELETE /api/versions/[id]
Auth: admin. Body: none. Response: `{ ok: true }`. Hard-delete — an
escape hatch for a mistaken "Save version" click; versions have no
soft-delete column (kept indefinitely by default, per the migration's
own comment).

### GET /api/projects/[id]/versions/compare?a=&b=
Auth: admin. Body: none. Query: `a`, `b` — each either an
`estimate_versions.id` or the literal string `"current"` (the live,
unfrozen estimate, built on the fly, never persisted). Response:
`VersionCompareResponse` — `{ a: {label, created_at}, b: {...},
sections: SectionDiffEntry[], ffeSubstitutions: FfeSubstitution[],
totalSavingExGst, totalA, totalB }`. Diff direction is always A → B
("was" = A, "now" = B — the UI picks which side is which). Per-section
deltas + changed/removed/added lines from `lib/estimate-versions.ts
diffSections()` (matched by line id, falling back to description-match
within the same section; sections matched by name — a rename between
two versions shows as one section removed + a different one added,
since a frozen snapshot has no stable cross-version section id).
`ffeSubstitutions` (matched by `item_code`) is **only populated when at
least one side is `"current"`** — a frozen version's snapshot stores
only the aggregated FF&E rollup, not per-item detail, so a
both-frozen-versions comparison still gets the section/line diff and
headline saving but an empty substitutions list. `totalSavingExGst =
a.wholeJob.combinedExGst - b.wholeJob.combinedExGst` (positive = B is
cheaper, a real saving — the "Total saving: $N ex GST" headline).

### UI
`components/estimate/VersionsPanel.tsx` — a fourth tab
("Versions") on `EstimateWorkspace.tsx` alongside
Estimate/Variations/Areas & Measurements: save-version form, versions
list (view/delete), a read-only snapshot viewer, and the VM comparison
picker (`components/estimate/VersionCompare.tsx` renders the compare
response). `EstimateView.tsx` itself is untouched — versioning lives as
a sibling tab, not inside the live estimate editor.

---

## SOW clause templates + "Start from template" — Phase 12a-A

BUILD-SPEC.md "SOW completion + Aria plan analysis" — clause library
extracted from `docs/sow-source-goldsworthy-v42.txt` +
`docs/sow-source-alley-v6.txt`, structured constants in
`lib/sow-templates.ts` (no new table/migration — a template is copied
into ordinary `sow_sections`/`sow_lines` rows, fully editable
afterwards via the existing builder). Team-visible (not admin-gated).

### POST /api/projects/[id]/sow/[sowId]/from-template
Auth: session. Body: `ApplyTemplateInput` — `{ groups?: string[],
include_rooms?: boolean }` (both optional; omitting `groups` applies
the full standard set — Project Overview, General Notes ×3 subgroups,
then room sections, then Site Management & Handover + Exclusions, in
that fixed order; `include_rooms` defaults `true`). Response: `{
sections: SowSectionWithLines[] }` (201) — the newly-created sections
(appended after any existing ones; never replaces). 400 if the parent
SOW isn't `status: 'draft'` (issued revisions are immutable, same rule
as every other SOW mutation route). Room sections are seeded from the
project's **`rooms` table** (the current per-project room model,
migration `015_rooms.sql`) via `lib/sow.ts roomSectionHeadings()` — NOT
`items.location` (that free-text legacy layer still drives the
original `POST /api/projects/[id]/sow`'s first-revision seed,
unchanged) — falling back to `SOW_FALLBACK_ROOMS` when the project has
no rooms defined yet.

### GET /api/projects/[id]/sow/draft-context
Auth: session. Body: none. Response: `{ rooms: [{ id, name, items:
[{item_code, name, description, category, quantity}], clause_pattern:
SowTemplateSection }], latest_plan_analysis }`. Read-only, no pricing —
the FETCH half of the MCP tool `draft_sow_section` (see docs/ARIA.md):
everything Aria needs to draft a grounded room-by-room SOW section
(the project's current rooms, each room's assigned FF&E items via
`item_rooms`, the latest plan analysis's discrepancies, and the
room-section clause skeleton from `lib/sow-templates.ts
roomSectionTemplate()`). The SUBMIT half reuses the existing
`POST /api/sow/sections/[sectionId]/lines` route directly — no
separate submit endpoint.

### UI
`components/sow/SowBuilder.tsx` gains a "Start from template" button
(draft SOWs only) next to "Download PDF"/"Issue" — calls the
from-template route above and folds the returned sections into local
state, same optimistic-append pattern as "+ Add section".

---

## Aria plan analysis + takeoff assist — Phase 12a-A

BUILD-SPEC.md "SOW completion + Aria plan analysis" (cross-reference
engine) + "Aria takeoff assist" (deterministic quantity takeoff). Team
access throughout (not admin-gated — plans/rooms/item-code data, no
pricing exposed by any route below).

### GET /api/projects/[id]/plan-analysis/pending
Auth: session. Body: none. Response: `{ files: (ProjectFile & { url:
string | null })[] }` — every `project_files` row of kind `'plans'`
that has **never** been analysed (no `plan_analyses` row references its
`file_id` yet), with signed URLs. This is the queue Aria's
plan-analysis automation polls.

### GET /api/projects/[id]/plan-analysis
Auth: session. Body: none. Response: `{ latest: PlanAnalysis | null }`
— the most recent analysis for the project, or `null`. Backs the
Overview tab's "Plan Check" card.

### POST /api/projects/[id]/plan-analysis
Auth: session. Body: `SubmitPlanAnalysisInput` — `{ file_id,
revision_label?, rooms: string[], item_codes: string[], dimensions?:
PlanAnalysisRoomDimensions[], analysed_by? }`. `file_id` must be a
`'plans'`-kind `project_files` row belonging to this project (400/404
otherwise). Response: `SubmitPlanAnalysisResponse` — `{ analysis,
measurements_drafted }` (201).

Runs the deterministic cross-reference engine
(`lib/takeoff.ts crossReferencePlans()`) in both directions plus room-
name mismatches, storing the result as `plan_analyses.discrepancies`:
1. **`code_missing_from_register`** — plan item codes not found in the
   register.
2. **`register_item_not_on_plan`** — register item codes never
   referenced on the plan set.
3. **`room_with_no_ffe_items`** — plan rooms with no register item
   whose `location` matches (case-insensitive, trimmed).
4. **`location_name_mismatch`** — register `location` values matching
   neither a plan room name nor a current `rooms` table entry (the
   "Plans T3 reference SS-01/SS-02 — register has ST-01/ST-02" case
   from the build spec).

When `dimensions` are supplied, also runs the takeoff assist
(`lib/takeoff.ts computeTakeoffs()`): floor m² (length × width),
painting m² (perimeter × ceiling height − opening allowances, default
2.4 m height / 1.8 m² per opening if not stated), tiling m² (wet areas
only — floor + all four walls to stated/default height). Writes one
`measurements` row per computed figure into a project-level
`"Takeoff — Draft (from plan analysis)"` measurement group (created on
first use), each with `status: 'draft'`, `source: 'takeoff'`, and
`provenance_note` set to one of the build spec's exact two phrasings
(`"derived from stated dimensions — verify"` or, for a room with no
stated length/width at all, that room is **skipped entirely** — no
measurement row is written, never guessed). A human site-measure then
`PATCH`es that measurement's `status` to `'verified'` (see below) — the
system never does this automatically, and never scale-measures off the
drawing.

### PATCH /api/estimate/measurements/[id] (extended)
Auth: admin (unchanged — the whole Areas & Measurements surface is
part of the financial-gated Estimate module). Body gains `status?:
'draft' | 'verified'` alongside the existing editable fields — the
"Confirm" action once a draft, takeoff-derived measurement has been
site-measured. `source` itself is not PATCH-able (provenance is fixed
at creation time).

### Overview card
`components/projects/PlanCheckCard.tsx` — self-contained, additive slot
mounted at the end of `ProjectOverview.tsx`'s card grid. Fetches its
own summary from `GET /api/projects/[id]/plan-analysis`; renders
nothing until at least one analysis has been run for the project (no
placeholder clutter for projects with no plans yet).

---

## MCP additions — Phase 12a-A

Three new tools in `mcp/src/index.mjs` (see `docs/ARIA.md` for the full
walkthrough) — all thin fetches to the routes above, no business logic
duplicated in the MCP layer:

- **`list_pending_plan_analyses`** — `{ project_id }` →
  `GET .../plan-analysis/pending`.
- **`submit_plan_analysis`** — `{ project_id, file_id, revision_label?,
  rooms, item_codes, dimensions?, analysed_by? }` →
  `POST .../plan-analysis`.
- **`draft_sow_section`** — two modes, one tool (matching
  `draft_diary_entry`'s established pattern): FETCH mode (`{ project_id
  }` only) → `GET .../sow/draft-context`; SUBMIT mode (`{ section_id,
  lines }`) → loops `POST /api/sow/sections/[sectionId]/lines` once per
  line. `section_id` must already exist (create it first via the normal
  SOW builder API/UI) — this tool only populates lines onto an existing
  draft section, it never creates the section itself, and never issues
  or publishes anything.

---

## My Work, Board v2, housekeeping, client events — Phase 12a-B

BUILD-SPEC.md "Phase 12a — My Work" (My Work half), "Board v2",
"Housekeeping — 5 July screenshot", "Portal — upcoming client
meetings". Local types in `types/phase-12a-b.ts` (not added to the
shared `types/index.ts` — the Phase 12a-A agent working concurrently in
this same tree left the identical pattern with `types/phase-12a-a.ts`,
for the same reason: avoid a shared-file collision between two agents
working the same migration window).

### Board v2

`GET /api/projects/[id]/board` — team-visible. Response now
`{ columns, groups, team }` (was `{ columns }` in Week 9): `columns`
carries the Kanban lens, `groups` the Grouped-list lens (empty until a
project's first visit to that view seeds it — see the seed route
below), `team` the project's roster for the assignee picker. Every task
now carries `assignees: { id, full_name }[]` (was a single `assignee`)
via the new `board_task_assignees` join table (migration 020) —
`board_tasks.assignee_id` still exists and is kept in sync (first
assignee, or null) for backward-compatible reads elsewhere, but is
DEPRECATED — nothing new reads it. New boards (first-ever visit, zero
existing columns) now seed Waiting → To Do → In Progress → Done
(Waiting first, BUILD-SPEC.md "Board v2" point 2); this reorder is
NOT retroactively applied to existing boards — see that route's doc
comment for why the "one-time reorder … if untouched" half of the spec
sentence is deliberately left as an on-machine follow-up rather than an
automatic migration-time mutation.

`POST /api/projects/[id]/board` — body adds `assignee_ids?: string[]`
(omit to auto-assign the creator; `[]` for none; a populated array
overrides auto-assign outright) and `phase_group_id?: string`.

`PATCH /api/board-tasks/[id]` — body adds `assignee_ids?: string[]`
(full replace of the task's assignee set) and `phase_group_id?:
string | null`.

`POST /api/projects/[id]/board/groups` — body `{ name }` → `{ group }`
(201). Manual single-group creation.

`POST /api/projects/[id]/board/groups/seed` — idempotent, seeds the
default phase template (Site Prep, Demolition, Rough-in, Waterproofing
& Tiling, Fit-off, Handover) ONLY if the project has zero `board_groups`
rows. Called by the Grouped-list view's first render, not by every
Kanban page load — see that route's doc comment.

`PATCH /api/board-groups/[id]` — body `{ name?, sort? }` → `{ group }`.

`DELETE /api/board-groups/[id]` — hard delete, no "must be empty"
guard (unlike columns) — cards in the group become ungrouped
(`phase_group_id` set null via `on delete set null`), never deleted.

### My Work

`GET /api/my-work` — per-user aggregator. Response:
`{ groups: { overdue, today, this_week, no_date }, is_admin }`. Sources
(each independently optional, none blocks the others on failure): my
`board_tasks` (via `board_task_assignees`), lead follow-ups
(admin-only — silently absent from the response for non-admins, not an
error), diary drafts pending approval (`portal_updates.status =
'pending_approval'`), trade-visit proposals awaiting response
(`trade_visits.status = 'proposed_change'`), items past
`decision_needed_by` with `client_approved = false AND client_flagged =
false` (no pricing fields ever selected), and — **added in Phase 13** —
my `office_tasks` (via `office_task_assignees`, `kind = 'task'` only,
`completed_at IS NULL` only — standing rule cards and already-archived
tasks never appear in My Work; see "Office board — Phase 13" below).
Bucketing logic in `lib/my-work.ts` (`bucketFor`, `groupMyWorkItems`),
pure and shared with any future client-side re-derivation, mirroring
`lib/leads.ts`'s shape.

`GET /api/my-work/notes` / `POST /api/my-work/notes` — personal
`user_notes` CRUD, always scoped to the signed-in user. `PATCH
/api/my-work/notes/[id]` / `DELETE /api/my-work/notes/[id]` — same
scoping (a forged id belonging to another user's note 404s).

### Housekeeping

- `Header` (`components/layout/Header.tsx`) gains two additive,
  optional props: `titleHref` (project name becomes a link back to
  Overview — BUILD-SPEC.md "Housekeeping" point 1) and `titleSuffix`
  (muted alias suffix next to the title — point 2). Every existing call
  site with neither prop renders identically to before.
- `projects.alias` (migration 020, text, nullable) — editable in
  `ProjectSettingsForm`, saved through the existing unrestricted `PUT
  /api/projects/[id]` (no new route needed — that route has no field
  allowlist, see "Known inconsistencies" #5 below). Displayed muted on
  the dashboard `ProjectCard`, the project Overview header, and My
  Work's project chips. NEVER read by the client portal or the
  builder/schedule PDF.
- `ProjectTabs` (`components/projects/ProjectTabs.tsx`) gains an
  additive optional `portalUrl` prop — renders a right-aligned "View
  client portal ↗" link (opens in a new tab) + a "Copy link" button
  (`components/projects/PortalLinkAction.tsx`) when supplied. Wired
  into all ten of this component's call sites via `lib/portal-link.ts`'s
  `portalUrlFor(token)` helper.

### Client events (portal "Upcoming meetings")

`GET /api/projects/[id]/client-events` / `POST
/api/projects/[id]/client-events` — team-visible, soonest-first list +
create. `PATCH /api/client-events/[id]` / `DELETE
/api/client-events/[id]` — edit/soft-delete; editing `starts_at` clears
`reminder_sent_at` (re-arms the day-before reminder for the new time).
Managed from the project Client area's new "Meetings" tab
(`components/client-area/ClientEventsPanel.tsx`). `notes` on this table
is CLIENT-FACING BY DESIGN (shown verbatim on the portal card) — unlike
`trade_visits.notes`, which is internal-only.

Portal: `app/portal/[token]/page.tsx` queries future (`starts_at >=
now`) non-deleted `client_events` and renders
`components/portal/UpcomingMeetingsCard.tsx` directly below the
existing "What's next" block. Past events are dropped by the query, not
rendered-then-hidden.

`POST /api/client-events/remind` (alias `GET`, same handler) —
day-before reminder trigger. Auth: `authorization: Bearer
${CRON_SECRET}` OR an authenticated team session — identical dual-path
pattern to `/api/trade-reminders` and `/api/digest/flush`. Business
logic in `lib/client-event-reminders.ts`'s `sendDueReminders()`: finds
events starting "tomorrow" (whole-calendar-day match) with
`reminder_sent_at IS NULL`, emails the project's client (primary +
secondary, same recipient-list pattern as `lib/notify-client.ts`),
stamps `reminder_sent_at` on success. **vercel.json is protected in
this task** — no cron entry was added. See this task's final report /
README for the exact line the on-machine engineer should add
(`{ "path": "/api/client-events/remind", "schedule": "0 21 * * *" }`,
same UTC slot as the existing `/api/trade-reminders` entry).

### MCP additions — Phase 12a-B

One new tool in `mcp/src/index.mjs`:

- **`create_client_event`** — `{ project_id, title, starts_at, ends_at?,
  location?, notes? }` → `POST .../client-events`. Description flags
  that `notes` is client-facing.

`create_board_task`'s schema was updated in place (additive, not a
breaking rename): `assignee_id` → `assignee_ids?: string[]` (omit to
auto-assign Aria's own account, Board v2's auto-assign-on-create), plus
a new optional `phase_group_id`.

---

## Office board — Phase 13

BUILD-SPEC.md §"13 Office" / `docs/OFFICE-BRIEF.md` (Aria's Monday
board export, 5 Jul 2026). A **global** Monday-style grouped-list board
— not per-project, no `project_id` anywhere in this schema — covering
business housekeeping: Marketing, Website, Meta Ads, Google Ads,
Operations, Systems & Tech, Phillip's personal queue, and Archived.
Team-visible, no admin gating (none of this data is financial, and the
"Phillip" group is everyone's view of his queue on the shared board, per
the brief — not a private one). Sidebar entry: `/office`, placed right
after My Work.

### GET /api/office

Full-board read: `{ groups: OfficeGroupWithTasks[], team:
OfficeTeamMember[] }`. Every non-deleted `office_groups` row, ordered by
`sort`, each with its non-deleted `office_tasks` nested (each task
carrying `assignees: OfficeAssigneeSummary[]` via
`office_task_assignees` and `subtasks: OfficeSubtask[]` via
`office_subtasks`, ordered by `sort`). `team` is the full profile
roster (`id, full_name, email`) — `email` is included specifically so
the `create_office_task` MCP tool can resolve an `assignee_email`
argument without a second route (this codebase has no standalone `GET
/api/profiles` listing route).

### POST /api/office/tasks

body: `{ group_id, title, description?, kind? ('task' default |
'rule'), due_date?, assignee_ids? }` → `{ task }` (201). Auto-assign on
create mirrors Board v2 exactly: omitting `assignee_ids` assigns the
creator; an explicit array (including `[]`) overrides outright. Rule
cards (`kind: 'rule'`) never carry assignees or a due date regardless of
what's passed — a rule is a pinned caution notice (e.g. OFFICE-BRIEF's
"DO NOT enable Google AI Max when prompted"), not a to-do someone owns.

### PATCH /api/office/tasks/[id]

body (partial): `{ title?, description?, due_date?, sort?, group_id?,
assignee_ids?, complete? }` → `{ task }`.

**Complete → Archive** is the one non-obvious behaviour here: passing
`complete: true` sets `completed_at = now()` AND moves the task's
`group_id` to the Archived group, remembering the original group on a
dedicated `prev_group_id` column (migration `021_office.sql`) — chosen
over encoding the origin group into `description` text, since a real FK
column stays queryable/indexable and survives a description edit made
while the task sits in Archived. `complete: false` reverses this
exactly: clears `completed_at`, restores `group_id` from
`prev_group_id`, clears `prev_group_id` back to `null`. Both directions
`409` for `kind: 'rule'` — standing rule cards are never completable.

A plain `group_id` edit (e.g. manually re-filing a card) is independent
of `complete` — moving a task into Archived this way does NOT set
`completed_at`, and moving one out this way does NOT touch
`prev_group_id` bookkeeping. This keeps "manually filed under Archived"
distinguishable from "completed and auto-archived" in the data even
though both land with `group_id = Archived`.

`assignee_ids` (full replace of `office_task_assignees`) works exactly
like `PATCH /api/board-tasks/[id]`'s own multi-assignee handling.

### DELETE /api/office/tasks/[id]

Soft-delete (`deleted_at`) — same as `board_tasks`.

### POST /api/office/subtasks / PATCH /api/office/subtasks/[id] / DELETE /api/office/subtasks/[id]

`{ task_id, title }` → `{ subtask }` (201) / `{ title?, done?, sort? }`
→ `{ subtask }` / hard delete. The Monday "subitems" equivalent (a
simple tick-list step, not a full nested card) — `done` toggles drive
the '2/5' progress chip on the parent task row in the grouped list.

### POST /api/office/groups / PATCH /api/office/groups/[id] / DELETE /api/office/groups/[id]

`{ name }` → `{ group }` (201) / `{ name?, sort? }` → `{ group }` /
soft-delete, refused (`409`) if the group still has active tasks (no
"ungrouped" fallback here, unlike `board_groups`' `on delete set null` —
every Office task always belongs to a real department). **The Archived
group is undeletable and unrenameable** — both the rename and delete
handlers special-case `name === 'Archived'` and reject with `409`
before touching the row; `sort` changes on Archived are still allowed
(re-ordering it relative to other groups is harmless). Archived renders
collapsed by default in the UI (client-side only, no API involvement).

### Schema reference (migration `021_office.sql`)

- `office_groups` — `id, name, sort, created_at, updated_at,
  deleted_at`. Seeded once (idempotent, "only if the table is currently
  empty"), in board order: Marketing, Website, Meta Ads, Google Ads,
  Operations, Systems & Tech, Phillip, Archived.
- `office_tasks` — `id, group_id (FK), title, description, kind ('task'
  | 'rule', default 'task'), due_date, sort, prev_group_id (FK,
  nullable — archive-on-complete memory), created_by, completed_at,
  created_at, updated_at, deleted_at`.
- `office_task_assignees` — `task_id, profile_id` join, mirrors
  `board_task_assignees` exactly.
- `office_subtasks` — `id, task_id (cascade), title, done, sort,
  created_at, updated_at`.
- RLS: single permissive `team_all` policy per table, same Phase 1
  shape as every other non-financial table.

### My Work integration

`office_tasks` assigned to me (via `office_task_assignees`), `kind =
'task'` only, not yet completed, feed `GET /api/my-work` as a sixth
source (`kind: "office_task"`, `href: "/office"`, `meta`: the
department group name) — see "My Work" section above. The My Work UI
(`components/my-work/MyWorkWorkspace.tsx`) renders an "Office" chip for
these rows (both the `KIND_LABEL` sand chip and, since these items carry
no `project`, the fallback outline chip that otherwise reads "Lead" for
project-less items — it now reads "Office" specifically for this kind).

### MCP additions — Phase 13

Two new tools in `mcp/src/index.mjs`, both thin wrappers with one
resolution step (fetch `GET /api/office` first to fuzzy-match a
department name / email against the live board, so Aria never needs to
already know an internal UUID):

- **`create_office_task`** — `{ title, group, description?, due_date?,
  assignee_email? }`. `group` is matched case-insensitively as a
  substring against current group names ("meta" → "Meta Ads"); no match
  fails with the valid group list. `assignee_email` resolves against
  `team[].email`; omitted, the task auto-assigns the calling account
  (Aria), matching `create_board_task`'s existing auto-assign shape.
- **`list_office_tasks`** — `{ group?, status? ('open' | 'completed') }`
  — filtered read, rule cards included and clearly marked (never
  "completed").

This is the route Aria's stated "outstanding items" pattern
(OFFICE-BRIEF.md: "any actionable item from email/WhatsApp/conversation
that doesn't belong on a job board goes on the Office board ... assigned
to Phillip with a due date") and her 24-48h resolution turnaround use —
see `docs/ARIA.md`'s "Office board (Phase 13)" section for the full
workflow write-up. There is deliberately no `complete_office_task` tool
— ticking a task done (and the resulting archive-move) stays a human
action, same structural boundary as the Diary's publish gate and the
SOW's issue gate elsewhere in this doc.

---

## Phase 14A — Performance & Backups (cross-cutting, not new routes)

BUILD-SPEC.md Phase 14 "Speed, Security & Backups". No new user-facing
routes beyond what's already noted inline above (PDF caching,
pagination on items/library/contacts/leads) — this section is a single
place to find the non-route additions:

- **`lib/image-url.ts`** — `renditionUrl()` (public-bucket URL rewrite
  to Supabase's image-transform endpoint, sync, no network call) and
  `signedRenditionUrl()` (private-bucket signed URL + inline transform
  in one call). Applied to: dashboard project cards, gallery grid,
  portal progress-photo/diary/handover photo grids, procurement board
  cards, portal Selections compact-row thumbnails. **NOT** applied to
  `components/items/SpecRegister.tsx` (protected/owned elsewhere this
  round) — see this task's build report for the one-line adoption note
  left for whoever owns that file next.
- **`lib/reference-data.ts`** — `getCategories()`/`getProfiles()`,
  `unstable_cache`-wrapped (5 min revalidate + explicit `revalidateTag`
  on every category/profile mutation route). Replaces ad-hoc
  `select("*")` calls on `categories`/`profiles` in the dashboard,
  library, project, and settings pages.
- **`app_errors` table** (migration 022) + **`lib/report-error.ts`** —
  rate-limited (5 per 5 min per call-site label) error logging from the
  PDF route, scrape pipeline, Monday sync (both the fire-and-forget and
  manual-retry paths), Gmail send (both the team digest and
  client-notification paths), and the signature route. Surfaced in
  Settings → **System health** (admin-only, last 50, most recent
  first). Sentry (or similar) remains the documented upgrade path —
  see `docs/RUNBOOK.md` §9 — deliberately not added as a dependency.
- **`scripts/backup-offsite.mjs`** — weekly, zero-dep, run on the mini
  (not Vercel): `pg_dump` (if available) + an incremental mirror of
  every Storage bucket (`assets`, `item-images`) with a `manifest.json`
  per week, 8-week retention. See `docs/RUNBOOK.md` for full
  disaster-recovery procedure, launchd scheduling, and the quarterly
  restore-drill checklist.
- **Migration 022** also adds two indexes for cross-project queries
  `GET /api/my-work` runs with no `project_id` predicate
  (`idx_items_mywork_decisions`, `idx_portal_updates_pending_approval`)
  — every other "heaviest query pattern" named in this task's brief
  already had a serving index from migrations 001-021; see the
  migration file's own header comment for the full audit trail.
- **Portal page caching decision:** deliberately did NOT add
  `revalidate`/ISR to `app/portal/[token]/page.tsx` — it already calls
  `headers()` (rate limiter), which forces fully dynamic rendering by
  Next.js's own semantics, so there is no stale cache to accidentally
  serve stale approval state from. See the page's own doc comment for
  the full reasoning.

---

## Fix round B — badges, portal selections separation, upload validation

### GET /api/badges
Auth: **session** (401 if signed out). Returns
`{ leads_followups: number, my_work_due: number }` in one call —
BUILD-SPEC.md §"Sidebar notification badges". `leads_followups` is
admin-only (0 for non-admins, mirroring `GET /api/leads/attention`'s
own gate); `my_work_due` is "today + overdue" across the same six
source tables `GET /api/my-work` aggregates, bucketed via the shared
`bucketFor()` helper (`lib/my-work.ts`) so the two routes' counts can
never drift, even though this route deliberately re-queries each
source with a narrower column selection (no joins/titles/hrefs — just
enough to bucket) to stay cheap for a poll-every-~3-min sidebar call.
`components/layout/Sidebar.tsx` polls this route on an interval and on
every route change, rendering a small red pill next to **Leads** and
**My Work** (hidden entirely at 0).

### GET /portal/[token]/selections (page, not an API route)
BUILD-SPEC.md §"Portal selections separation". A second, separate
portal page — "Your selections" — showing only `client_approved =
true` items, grouped by room, thumbnail + code + name only (no
description/supplier/qty/pricing — narrower than the main page's
`PORTAL_FIELDS`). Same guards as the parent portal page: `noindex`
metadata, a per-token+IP rate-limit bucket (its own key,
`portal-selections-page:...`, so it can't exhaust the parent page's
budget or vice versa), and a service-role token→project lookup (404 on
no match). The MAIN portal page's Selections section
(`components/portal/SelectionsSection.tsx`) now shows ONLY items
needing a decision (not yet approved, or flagged) — approving an item
shows a brief "moved to Your selections" note in place of the row
before it drops off the list on next load, rather than vanishing
instantly. A compact link card ("Your selections · N approved →") and
a `PortalNav` entry (a real `next/link`, not an in-page anchor like
every other `PortalNav` entry) both point at the new page — both
hidden when there are zero approved items.

### Upload validation — magic-byte sniffing
BUILD-SPEC.md §"Phase 14 follow-ups" point 5 (audit backlog). New
`lib/file-sniff.ts` — no new dependency, hand-checked magic numbers for
JPEG/PNG/WebP/PDF — with `validateUploadBytes(bytes, claimedType)`
(rejects an obvious content/label mismatch, e.g. a renamed executable
labelled `image/jpeg`) applied to every upload route that receives
bytes directly:
`POST /api/items/[id]/files`, `POST /api/projects/[id]/invoices`,
`POST /api/projects/[id]/cover`, `POST /api/projects/[id]/site-photos`.
`POST /api/projects/[id]/files` is different — its bytes go straight
from the browser to Storage via a signed upload URL
(`POST .../files/upload-url`), bypassing this app's server entirely, so
this route instead calls the new `sniffStorageObjectHead()` helper to
read back just the first 16 bytes of the just-uploaded object (a
`Range: bytes=0-15` request against a short-lived signed URL) and
checks those against the claimed `kind` — fails OPEN (skips the check
without blocking the upload) if that read-back itself errors, since
it's a defence-in-depth layer on top of the existing path-ownership
check, not the sole guard. Every sniff check is deliberately lenient
about formats it doesn't recognise (e.g. a `.docx` spec sheet) — it
only rejects a clear JPEG/PNG/WebP/PDF mismatch, never blocks a
legitimate upload of some other document kind this app already
accepts.

### lib/rate-limit.ts — loginRateLimit() (exported, not wired up)
BUILD-SPEC.md §"Phase 14 follow-ups" point 5 also names "login rate
limit". Added `loginRateLimit(key)` (5 attempts / 5 min, its own bucket
namespace) alongside the existing `rateLimit()`. **Not wired into**
`app/(auth)/login/page.tsx` — that page's only sign-in path is the
BROWSER Supabase client's `supabase.auth.signInWithPassword()` called
directly from a `"use client"` component; there is no Next.js server
route/Server Action in between for this in-memory, server-side limiter
to attach to (calling it from client code would just rate-limit each
browser tab against itself, not a real boundary). Supabase Auth already
rate-limits `signInWithPassword` server-side. The export exists ready
for a future server-side login flow (e.g. if MFA or server-side audit
logging is ever added) rather than leaving that future work to
reinvent one.

### mcp/src/index.mjs — 24h forced re-auth
BUILD-SPEC.md §"Phase 14 follow-ups" point 5 also names "MCP 24h
re-auth". `getAccessToken()` now tracks `cachedAccessTokenAt` alongside
the cached token and forces a fresh `signIn()` once the cached token is
≥24h old, in addition to the existing reactive 401-triggered re-auth —
this MCP server runs as a long-lived process on Aria's Mac mini, so
the proactive cap prevents it from holding one access token
indefinitely just because it happens to keep working.

---

## Fix Round A — phase unification, pre-populated phases, umbrella span, vertical board, trade insurance

BUILD-SPEC.md "Phase 14 follow-ups from Phillip's testing" items 1–4 +
"Board vertical layout". Migration `023_phases_insurance.sql`. Phase↔
board-group unification (item 2), the umbrella span fix (item 4), and
the vertical board default (item 5, `components/board/ProjectBoard.tsx`)
were built in an earlier pass of this same task; this section documents
what this pass added on top: the phase-template Settings editor (item
3) and the trade insurance tracker's remaining surface (item 6).

### GET /api/settings/phase-template
Auth: session (team-visible — studio-wide configuration, not
financial, same trust tier as `GET /api/categories`). Response:
`{ template: [{ name, kind }] }` — read from
`app_settings('phase_template')` (migration 023), falling back to
`lib/phase-template.ts`'s `FALLBACK_PHASE_TEMPLATE` if that row is
somehow missing.

### PUT /api/settings/phase-template
Auth: **admin**. Body: `{ template: [{ name, kind }] }` — full
replace. Validates: non-empty array, every row has a non-empty
trimmed `name` and `kind ∈ phase | umbrella`, and **exactly one** row
is `kind='umbrella'` (400 otherwise — `lib/phase-seed.ts`'s seed path
assumes a single umbrella row per project). Does **not** retroactively
touch any already-seeded project — only changes what newly-seeded
projects get. Backs `components/settings/PhaseTemplateSettings.tsx`,
an additive section on the Settings page (list editor: add/rename/
reorder/delete, mirroring `CategorySettings.tsx`'s shape).

### GET /api/contacts/[id]/documents
Auth: session. Response: `{ documents: ContactDocumentWithUrl[] }` —
a contact's non-deleted `contact_documents`, most recent first, each
with a freshly-minted signed URL (`assets` is a **private** bucket —
same `withUrl()` pattern as `GET /api/items/[id]/files`).

### POST /api/contacts/[id]/documents
Auth: session. Body: `{ kind, storage_path, filename, expiry_date? }`
— metadata-only; the file itself is uploaded directly to Storage via
`POST /api/contacts/[id]/documents/upload-url` first (two-step signed-
upload-URL flow, bypassing the ~4.5 MB Vercel body limit, same
approach as `POST /api/projects/[id]/files`). `kind` must be one of
`public_liability | workers_comp | licence | other`; `storage_path`
must start with `contacts/{id}/documents/`. Response: `{ document }`
(201).

### POST /api/contacts/[id]/documents/upload-url
Auth: session. Body: `{ filename }`. Mints a signed upload URL/token
for a direct-to-Storage `PUT`. Response: `{ path, token }`.

### PATCH /api/contact-documents/[id]
Auth: session. Body: `{ expiry_date?, verified_at? }` — the two
fields edited in place after upload (correcting a date, marking
verified) rather than delete-and-reupload. Response: `{ document }`.

### DELETE /api/contact-documents/[id]
Auth: session. Soft-deletes the row (`deleted_at`, kept for
compliance-audit history) **and** removes the underlying Storage
object immediately (unlike `project_files`' pure soft-delete-only
semantics) — mirrors `DELETE /api/item-files/[fileId]`. Response:
`{ ok: true }`.

### GET /api/contacts and GET /api/contacts/[id] (extended)
Both now additionally return `insurance_status` (`current | expiring |
expired | missing`, computed by `lib/insurance.ts`'s
`computeInsuranceStatus()` from the contact's `insurance_required`
flag — **migration 026**, Quick items round 6 July 2026, superseding
the former `TRADE_CATEGORIES` category-heuristic entirely — and its
non-deleted `contact_documents`; only `public_liability`/`workers_comp`
kinds count; `missing` is only ever returned when `insurance_required =
true`) and, on the list route only, `document_count`.
`components/contacts/ContactsBrowser.tsx` shows a status badge per
contact (suppressed when `insurance_required = false` and zero
documents — nothing to flag) and an expandable `ContactDocumentsPanel`
(a "Certificate needed" checkbox that PATCHes `insurance_required`,
upload/list/delete, editable expiry date, re-fetches the single-contact
route after any change to refresh the badge without re-fetching the
whole list).

### GET /api/contacts/attention
Auth: session. Response: `InsuranceAttentionGroups` — `{ expired,
expiring, missing }`, each an array of `insurance_required = true`
contacts in that insurance state (`lib/insurance.ts`'s
`computeInsuranceAttention()`). Mirrors `GET /api/leads/attention` /
`GET /api/visits/attention`'s existing pattern; also folded additively
into `GET /api/my-work`'s combined feed as `insurance_expiring` items.

### POST /api/projects/[id]/visits and POST /api/visits/[id]/confirm (extended)
Both responses gain `insurance_warning: string | null` —
`lib/insurance.ts`'s `insuranceWarningForBooking()` result for the
visit's linked contact's **current** insurance status at the moment of
the request (`null` when there's no linked contact, or insurance is
`current`/`expiring`; a message when `expired` or `missing`). Purely
advisory — **never blocks** the create or confirm. Surfaced
non-blockingly in the booking UI: `AddVisitForm` (inside
`components/gantt/GanttChart.tsx`'s `VisitsPanel`) shows it under the
form after a successful add; `components/gantt/VisitBottomSheet.tsx`
shows it after "Confirm on behalf of trade" succeeds.

---

## Design Framework — Phase 12b (final planned phase)

BUILD-SPEC.md §"Phase 12b + 13 — specced from Aria's briefs" / "12b
Design Framework" (from `docs/DESIGN-FRAMEWORK-BRIEF.md`, Aria's Monday
board export, Board ID 5027297754). A **per-project** design pipeline —
NOT the Monday board itself (that stays in Monday), a lighter-weight
spec-system checklist covering the same 7-phase shape: Project
Milestones, Presentation, Concepts, 3D Working Model, WD Package,
Renders, Sampling & Furniture (the brief's own separate "Sampling" and
"Furniture" Monday groups are combined into one phase here, per this
task's own brief wording). Team-visible, not admin-gated — design work
carries no pricing/financial data at all. New project tab **Design**,
placed between Overview and FF&E in the tab bar.

Deliberately its own table family (`design_phases` / `design_tasks` /
`design_task_assignees`), separate from `schedule_phases`/`board_groups`
(construction phases, unified as of migration 023 with gantt dates and
trade contacts) — design phases have no gantt span and no trades; see
migration `025_design_framework.sql`'s own header comment for the full
reasoning.

### GET /api/projects/[id]/design

Full Design-tab read: `{ phases: DesignPhaseWithTasks[], team:
DesignTeamMember[], progress: DesignPhaseProgress[] }`. **Seeds the 7
brief phases on a project's first call** (same lazy "seed if currently
zero rows" pattern as `board_columns`/the Board's Grouped-list view —
NOT the migration-time global seed `schedule_phases`' phase template
uses, since `design_phases` is genuinely per-project data). Each phase
carries its non-deleted `design_tasks` nested, each task carrying
`assignees: DesignAssigneeSummary[]` via `design_task_assignees`.
`team` carries `email` alongside `id, full_name` (mirrors
`OfficeTeamMember`) so the `create_design_task` MCP tool can resolve an
`assignee_email` argument without a second route. `progress` is a
derived convenience (`lib/design-framework.ts`'s `allPhaseProgress()`)
— the per-phase `{ phase_id, name, status, done_count, total_count }`
chip data; safe to ignore, since `phases` already carries everything
needed to compute it client-side.

### PATCH /api/design-phases/[id]

body: `{ status? ('not_started' | 'in_progress' | 'complete' | 'na'),
hinge_dismissed? }` → `{ phase }`. `status` is a free write, no
state-machine guard (same as `DocumentStatusLight`'s own cycle) — with
two side effects: transitioning into `'in_progress'` stamps
`started_at` if not already set; transitioning into `'complete'` stamps
`completed_at`, transitioning OUT of it clears `completed_at`.
`hinge_dismissed: true` stamps `hinge_dismissed_at` (see the hinge
section below) — meaningful only on the "WD Package" phase row, but
accepted on any phase without a name check (harmless no-op elsewhere).

### POST /api/design-tasks

body: `{ design_phase_id, title, description?, due_date?,
assignee_ids? }` → `{ task }` (201). Auto-assign on create mirrors
Board v2/Office board exactly: omitting `assignee_ids` assigns the
creator; an explicit array (including `[]`) overrides outright.

### PATCH /api/design-tasks/[id] / DELETE /api/design-tasks/[id]

body (partial): `{ title?, description?, due_date?, sort?,
assignee_ids?, complete? }` → `{ task }`. `complete: true`/`false`
stamps/clears `completed_at` — no archive-move side effect (unlike
Office board's complete-and-archive); a design task's phase never
changes on completion, it just ticks. `assignee_ids` (full replace)
works exactly like every other multi-assignee PATCH route in this
codebase. `DELETE` soft-deletes (`deleted_at`).

### The WD-Package hinge

BUILD-SPEC.md: "completing WD Package prompts SOW + estimate version
creation ('design package → quoting')." Purely a **client-side** prompt
— no server-side notification fires on the status write itself. The
Design tab (`components/projects/design/DesignTab.tsx`) shows a
dismissible banner (`WdPackageHingePanel.tsx`, "Design package complete
— start quoting?") whenever `lib/design-framework.ts`'s
`shouldShowWdPackageHinge()` is true: the "WD Package" phase is at
`status: 'complete'` AND `hinge_dismissed_at` is still `null`.

Two actions, both optional and independent of dismissal:
- **"Create SOW from template"** chains two existing, unchanged
  routes — `POST /api/projects/[id]/sow` (creates a new draft
  revision) then `POST /api/projects/[id]/sow/[sowId]/from-template`
  (applies the standard clause library to it) — then redirects to
  `/projects/[id]/sow`. If the template step fails, the SOW revision
  itself still exists and the team lands in the builder to apply it
  manually.
- **"Save estimate version"** — `POST /api/projects/[id]/versions` with
  `{ label: "V1 — Design Package", kind: "issue" }` (admin-only
  server-side, like every estimate route — a non-admin sees the 403
  inline rather than the button being hidden, since the Design tab
  itself isn't admin-gated).

Dismissal (`✕` or "Dismiss") calls `PATCH /api/design-phases/[id]` with
`{ hinge_dismissed: true }`, recorded on `design_phases.hinge_dismissed_at`
so the panel never nags again for that project.

### Schema reference (migration `025_design_framework.sql`)

- `design_phases` — `id, project_id (cascade), name, sort, status
  (check: not_started | in_progress | complete | na, default
  not_started), started_at, completed_at, hinge_dismissed_at,
  created_at, updated_at`.
- `design_tasks` — `id, design_phase_id (cascade), title, description,
  due_date, sort, completed_at, created_by, created_at, updated_at,
  deleted_at`. No pricing/cost column anywhere — this is a design
  checklist, never a quoting surface.
- `design_task_assignees` — `task_id, profile_id` join, mirrors
  `board_task_assignees`/`office_task_assignees` exactly.
- RLS: single permissive `team_all` policy per table, same Phase 1
  shape as every other non-financial table.

### Overview integration

`components/projects/DesignProgressCard.tsx` — additive card in the
Overview grid (same "self-contained fetch, safe mount" pattern as
`PlanCheckCard`), fetching `GET /api/projects/[id]/design` and
rendering the 7 phases as compact status dots + label, with a link to
the Design tab.

### My Work integration

`design_tasks` assigned to me (via `design_task_assignees`) with a
`due_date` set, not yet completed, feed `GET /api/my-work` as an eighth
source (`kind: "design_task"`, `href: "/projects/{id}/design"`, `meta`:
always the literal string `"Design"`) — see "My Work" section above.
The My Work UI renders a "Design" chip for these rows via
`KIND_LABEL.design_task`.

### MCP additions — Phase 12b

Two new tools in `mcp/src/index.mjs`, same "fetch the live resource
first, fuzzy-match a free-text argument against it" shape as
`create_office_task`:

- **`list_design_phases`** — `{ project_id }` → the full
  `GET /api/projects/[id]/design` payload (seeds the 7 phases on first
  call for a project that has none yet).
- **`create_design_task`** — `{ project_id, phase, title, description?,
  due_date?, assignee_email? }`. `phase` is matched case-insensitively
  as a substring against that project's current phase names ("wd" →
  "WD Package"); no match fails with the valid phase-name list.
  `assignee_email` resolves against `team[].email`; omitted, the task
  auto-assigns the calling account (Aria).

No MCP tool exposes phase status changes or the WD-Package hinge
actions — those stay human/UI-only, same structural boundary as every
other "completion is a human action" gate in this codebase (Office
board's complete-and-archive, the Diary's publish gate, the SOW's issue
gate).

---

## Small round — image modal, add to calendar, item code editing (6 July 2026)

Three independent, code-only additions off BUILD-SPEC.md's "Image
options → modal picker", "Phillip's ideas list — 6 July 2026" item 2
(calendar), and "Improvements backlog" item 1 (editable codes). No new
migration — verified none of the three needed a schema change (see
each sub-section below).

### Image options modal picker

No new route — reuses the existing image-selection flow
(`POST /api/items/[id]/image`, unchanged) through a new client-side
modal, `components/items/ImagePickerModal.tsx`. `ItemAssets.tsx`'s
expanded-row image section now shows only the selected thumbnail plus
a "Choose image · N found" button (only rendered when
`image_options` has entries); the button opens the modal, which shows
the full candidate grid at a larger size, an "Upload new" button, and
highlights the current selection. Checked `components/library/**` for
an equivalent library-side image grid to reuse this for — none exists
(`LibraryBrowser.tsx` uses a single `default_image_url`, no
`image_options`-style array or grid UI at all), so this round is
items-only by design, not an oversight.

### Add to calendar

New `lib/ics.ts`: `generateIcs({ title, start, end, location,
description, attendees[] })` — hand-rolled RFC 5545, no new dependency.
Always emits UTC (`YYYYMMDDTHHMMSSZ`) DTSTART/DTEND/DTSTAMP — see that
file's own extended doc comment for why this sidesteps ACST/ACDT
daylight-saving handling entirely (RESLU is Adelaide-based; every
mainstream calendar client converts a UTC-suffixed timestamp to the
viewer's own zone automatically, so no VTIMEZONE block is needed).
Escapes TEXT fields, folds long lines, and builds a stable `UID` per
event so re-downloading the same event updates rather than duplicates
it. `googleCalendarUrl(...)` builds the matching
`calendar.google.com/calendar/render` link (Google's own "Add to
Calendar" share-button URL shape — no OAuth/API needed; `add=` opens
Google's own invite UI pre-filled, it does not silently email anyone).

Two GET routes stream a `.ics` file, both requiring a signed-in team
session (leads additionally require **admin**, matching the rest of
that module):

#### GET /api/leads/[id]/calendar.ics
Auth: **admin**. Query: `?attendees=email1,email2` (optional,
comma-separated). Response: `text/calendar` attachment,
`Content-Disposition: attachment`. 400 if the lead has no
`site_visit_date` set. Title: `"{first_name} {surname_project} — Site
Visit"`; location falls back `site_visit_location` → `location`; no
separate site-visit end-time column exists on `leads`, so the event
defaults to lib/ics.ts's own 1-hour fallback.

#### GET /api/client-events/[id]/calendar.ics
Auth: session (team — same gate as the rest of the `client_events`
module, no extra admin check). Query: `?attendees=email1,email2`
(optional). Response: `text/calendar` attachment. Uses the event's own
`starts_at`/`ends_at`; description includes the project name (joined
from `projects`) plus the event's own `notes` (client-facing by design
— see `client_events.notes`'s own doc comment in migration 020 — but
this route is team-authed only, never reached from the portal).

#### GET /api/profiles
Auth: session. Response: `{ profiles: { id, full_name, email }[] }`
(cached 5 min, same `PROFILES_CACHE_TAG` as every other profiles read —
see `lib/reference-data.ts`). New — until this round there was no
standalone listing route for the team roster (every prior caller either
queried `profiles` inline per-route or used the cached
server-component-only `getProfiles()`). Backs the new invitee picker
(`components/shared/AddToCalendarMenu.tsx`) on both the lead detail
panel and each client event row — selected emails feed both the `.ics`
routes' `?attendees=` param and `googleCalendarUrl()`'s `add=` param.

UI: `components/shared/AddToCalendarMenu.tsx` — a shared "Add to
calendar ▾" button (Download .ics / Open in Google Calendar, plus the
invitee checkbox list when `invitees` is passed) wired into
`components/leads/LeadDetailPanel.tsx` (next to the site visit
date/time field) and `components/client-area/ClientEventsPanel.tsx`
(on every event row, upcoming and past). Uses `position: absolute`
anchored to its own `relative` wrapper, not `fixed` — see that
component's doc comment for why `fixed` would be a layout trap here
(the client events list scrolls; a `fixed` menu would stay pinned to
the viewport instead of tracking its row).

### Item code editing

#### PATCH /api/items/[id] (extended)
`EDITABLE_FIELDS` gains `item_code`. Still DB-*generated* at insert
(migration 001's `trg_items_assign_code` trigger is untouched — a
blank code on create is still auto-numbered exactly as before); this
only adds a write path for correcting an existing code afterward.
Validation: trimmed + uppercased, then checked against
`^[A-Z]{2,3}-\d{1,3}$` (exported as `ITEM_CODE_PATTERN` from
`types/phase-small-round.ts`) — 400 on empty or malformed input. On a
conflict with another active item in the same project: **409** with
`{ error: "Item code \"TW-05\" is already used by another item in this project" }`
(checked explicitly ahead of the write for a clean message; the DB's
own `idx_items_project_code_active` unique index is still the
belt-and-braces backstop — a concurrent write between the check and
the update surfaces as the same 409 via the Postgres `23505` error
code). **Changing a code never renumbers sibling codes** — see the
route's own "Deliberately NOT renumbering" comment for the full
reasoning: item codes are referenced by number in artefacts outside
this database (a builder PDF schedule already sent to a client, a
signed Scope of Works, a supplier purchase order), so a renumbering
cascade would silently invalidate cross-references this system has no
way to reach back into and fix.

**No UI exists for this yet.** `components/items/SpecRegister.tsx` (the
file that would host the input) was out of this round's edit boundary
— see `docs/HANDOFF-code-editing.md` for exact wiring instructions
(which cell, which existing `onPatch` call, how the 409 message should
surface) for whoever picks this up next.

---

## Known inconsistencies (carried over, not fixed this release)

Documented here rather than silently relied upon, since Aria and human
callers alike should know about them:

1. No `middleware.ts` exists — every route's auth is self-contained;
   there is no framework-level fallback if a handler's check is
   accidentally removed.
2. Admin-403 message text is not standardised (`"Only admins can
   manage categories"` vs `"Admin access required"` vs
   `"Only admins can access the Estimate module"`, etc.) — don't
   pattern-match on exact 403 body text across routes.
3. `DELETE /api/library/[id]` has no admin check, while
   `DELETE /api/categories/[id]` does, and `PATCH`/`POST` on the same
   library resource gate financial fields — any signed-in team member
   can hard-delete a library catalogue entry today.
4. Soft- vs hard-delete is per-resource, not a project-wide rule:
   items/projects/cost_lines/variations/project_files soft-delete
   (`deleted_at` or `status`); categories/library_items/measurements/
   item_files hard-delete. Check the specific route above before
   assuming either behaviour.
5. `PUT /api/projects/[id]` has no field allowlist beyond stripping
   `id`/`client_token`/`created_at`/`updated_at` — it can set
   `status: "archived"` directly, a second path to the same effect as
   `DELETE /api/projects/[id]`.
6. `GET /api/monday/boards` returns HTTP 200 on internal failure (with
   an `error` field in the body); `POST /api/monday/sync/[itemId]`
   returns 502 for the equivalent failure — check response bodies, not
   just status codes, around Monday integration.

---

## Quick items round (Phillip, 6 July 2026)

Two small, unrelated fixes from Phillip's testing notes. Migration
`026_insurance_required.sql`.

### Item 1 — Insurance required flag
Replaces the trade-insurance tracker's category-based guess
(`lib/insurance.ts`'s former `TRADE_CATEGORIES` allow-list /
`isTradeCategory()`, Fix Round A) with an explicit column:
`contacts.insurance_required boolean not null default false`
(migration 026). The migration's one-time backfill sets this `true`
for every existing contact whose category matched the old hardcoded
trades list (copied into the migration as literals, with a comment —
that list is no longer read by application code; the column is the
single source of truth going forward).

`lib/insurance.ts`'s `computeInsuranceStatus(insuranceRequired,
documents, now?)` signature changed (first param is now the boolean
flag, not a category string) — `missing` is returned only when
`insuranceRequired` is `true` and there are zero qualifying
(`public_liability`/`workers_comp`, non-deleted) documents; `false`
always yields `current` when there are no qualifying documents (no
badge). `isTradeCategory()`/`TRADE_CATEGORIES` are deleted from that
file entirely. Every call site was updated to pass
`contact.insurance_required` instead of `contact.category`: `GET
/api/contacts`, `GET /api/contacts/[id]`, `GET /api/contacts/attention`,
`GET /api/my-work` (source #7), `POST /api/projects/[id]/visits`, `POST
/api/visits/[id]/confirm` — all five booking-warning/needs-attention
call sites verified still correct against the new signature.

`PATCH /api/contacts/[id]` — `insurance_required` added to
`EDITABLE_FIELDS`. `components/contacts/ContactsBrowser.tsx`'s expand
panel (`ContactDocumentsPanel.tsx`) now shows a "Certificate needed"
checkbox above the documents list; toggling it PATCHes
`insurance_required` (optimistic, reverts on failure) and re-fetches
the contact's `insurance_status` so the parent card's badge stays in
sync. The status badge itself renders only when `insurance_required =
true` OR the contact already has at least one document on file (same
"don't hide an existing status" reasoning Fix Round A used for the
category heuristic).

### Item 2 — Portal selections separation (stronger cut)
The Fix Round B "portal selections separation" left the main portal
page's `SelectionsSection` still rendering full awaiting/flagged item
cards (room groups, expand-to-details, approve/flag actions, bulk
approve, the "Review one by one" stepper) — only approved items had
moved to `/portal/[token]/selections`. This round finishes the cut:

- **`components/portal/SelectionsSection.tsx`** (main page) is now a
  compact summary card only: a progress bar (approved / total,
  excluding nothing), "N awaiting your decision →" linking to
  `/portal/[token]/selections`, a flagged-count chip when > 0, and a
  deadline warning when any un-approved item's `decision_needed_by` is
  past or within 7 days (amber for "soon", red for "overdue" — same
  amber/red convention `isOverdue`/deadline styling already used
  elsewhere on the portal). Zero item-level rendering (no thumbnails,
  no room groups, no approve/flag buttons, no stepper) remains on the
  main page.
- **`app/portal/[token]/selections/page.tsx`** — extended from its
  previous approved-only gallery into the full selections workspace:
  three tabs (Awaiting / Flagged / Approved), room grouping preserved
  within each tab, the "Approve all N in this room" bulk action and the
  full-screen "Review one by one" stepper both moved here from the old
  `SelectionsSection`. `YourSelectionsGallery.tsx` (approved-only,
  read-only grid) is retained and used for the Approved tab; a new
  client component renders the Awaiting/Flagged tabs (thumbnail rows,
  expand for description/supplier/qty/files, approve/flag, bulk-approve
  per room) — functionally the same JSX `SelectionsSection` used to
  own, moved wholesale rather than rewritten, so behaviour (including
  the "moved to Your selections" transient note and per-item
  `approval_events` on both single-item and bulk actions) is unchanged.
- **`components/portal/PortalNav.tsx`** — the "Selections" entry is now
  **always** a real link to `/portal/[token]/selections` (`next/link`,
  not an in-page `#selections` anchor) — since the main page no longer
  has a `#selections` section with item content to scroll to, an
  anchor would land on an empty summary card. The nav's on-page anchor
  list (`SECTIONS`) drops `selections`; the link renders unconditionally
  (not gated behind `approvedCount > 0` any more, since there's always
  something to review even before anything is approved).
- Every existing guarantee is preserved on the sub-page: token gating +
  per-token rate limiting + `noindex` (copied from the main page's
  guards, as the fix-round page already did), zero pricing fields ever
  selected, bulk-approve + stepper both still write individual
  `approval_events` rows per item (never a combined "bulk" event).

## Round A — "Board owns dates, Timeline is the visual", tab bar polish

No new migration; no route CONTRACT changes beyond one additive field
on an existing response (see below). Ran alongside a second, isolated
agent's own round in this same working copy (quantity-links/calculators
— their files: `supabase/migrations/027*`, `lib/takeoff*`,
`lib/materials*`, `components/calculators/**`,
`components/items/ProcurementView.tsx`, `app/api/materials/**`,
`app/api/calculators/**`, estimate route/view additions, `mcp/**`) —
none of those files were touched by this round.

**`GET /api/projects/[id]/board`** — response's `groups` entries
(`BoardGroupWithTasks`, `types/phase-12a-b.ts`) gain two additive,
read-only fields: `phase_start_date: string | null` and
`phase_end_date: string | null` — the linked `schedule_phases` row's
own dates (via a second lightweight query keyed by every group's
`phase_id`, merged in server-side), both `null` when a group has no
linked phase (`phase_id` is `null`). Nothing existing changes shape;
this is purely additive. `POST /api/projects/[id]/board/groups` and
`POST /api/projects/[id]/board/groups/seed` are UNCHANGED (still return
bare `board_groups` rows with no phase-date projection) — the client
(`components/board/ProjectBoard.tsx`) fills both new fields with `null`
for a group it just created locally, until the next full board GET
(e.g. a reload) picks up the real dates. This is a display-only gap
(the group's real dates already exist in `schedule_phases` from the
moment it's created — see that route's "unification invariant" doc
comment) and was judged acceptable rather than adding a third query to
two routes whose response shape nothing else needed to change.

**Board group date inputs** (`components/board/ProjectBoard.tsx`,
Grouped-list view) — a phase-linked group's header
(`GroupTable`/`GroupPhaseDateInputs`) now shows compact start/end date
inputs next to its name, rendered ONLY when `group.phase_id` is set;
unlinked/legacy groups (`phase_id === null`) show nothing extra.
Changing either date PATCHes the linked phase directly — **`PATCH
/api/phases/[id]`**, the EXACT SAME route the Timeline tab's own phase
edit panel already uses — never `board_groups` (which has no date
columns). Optimistic, reverts on failure. This means a date set from
the Board is immediately visible on the Timeline tab and vice versa,
with zero new sync code, since both surfaces write through one route
to one row.

**Timeline slider bars** (`components/gantt/GanttChart.tsx` +
`components/gantt/UmbrellaBand.tsx` + new `lib/phase-drag.ts`) — every
phase bar (ordinary phases AND the umbrella band) is now pointer-drag
interactive:
- Grab the bar body (`pointerdown` outside the 6px edge zones) → drags
  the WHOLE phase, `start_date`/`end_date` shift by the same
  day-snapped delta.
- Grab within 6px of the bar's left/right edge → resizes just that
  edge (`resize-start`/`resize-end`), clamped so the phase can never
  shrink below a 1-day duration.
- Day-snapping: `lib/phase-drag.ts`'s `snapDeltaDays(deltaPx,
  weekColumnPx)` divides the caller-measured week-column pixel width by
  7 (`pxPerDay`) — `weekColumnPx` is measured ONCE per drag gesture
  from the actual rendered grid body (`gridBodyRef`,
  `getBoundingClientRect().width` minus the 200px name column, divided
  by `grid.weekCount`), i.e. the exact same `(100% / weekCount)`
  division `lib/gantt.ts`'s own CSS `calc()` bar-position formula uses
  — `lib/gantt.ts` itself is UNTOUCHED by this round (verified via
  mtime), so there is no risk of the drag math drifting from either the
  internal Timeline's own bar rendering or the read-only portal mirror
  (`components/portal/TimelineSection.tsx`, which only ever reads
  `lib/gantt.ts`'s existing exports and has no drag interaction at
  all).
- Visual feedback while dragging: the bar being dragged gets
  `opacity-60` + a `outline-2 outline-nearblack` outline; cursor is
  `cursor-grab` at rest, `cursor-grabbing` while dragging (edge zones
  don't get a separate `col-resize` cursor style pre-drag — the 6px
  zones are invisible hit-targets, not visually delineated, consistent
  with the "compact" bar sizing already in place).
- Commit: PATCHes `/api/phases/[id]` on `pointerup` with the final
  day-delta (optimistic update, revert-on-failure — reuses the exact
  same `patchPhase()` helper the edit panel and context-menu actions
  below all share).
- Touch: deliberately does NOT attempt edge-drag or move-drag at all
  (`pointerType === "touch"` short-circuits `handlePointerDown`) — a
  tap still opens the existing edit panel unchanged (the pre-existing
  `onToggleEdit` click handler on the phase name), per this round's
  explicit "Touch: do NOT attempt edge-drag ... tap opens the existing
  edit panel (unchanged fallback)" instruction.

**Right-click context menu** — new **`components/shared/ContextMenu.tsx`**
(generic: `items: ContextMenuItem[]`, `position`, closes on Esc /
click-away / scroll of any ancestor, brand-styled fixed panel,
supports one level of submenu for "Change colour"). Wired into
`GanttChart.tsx`:
- Right-click a phase bar (ordinary or umbrella) → **Edit dates**
  (expands the existing edit panel — no new UI), **Shift −1 week** /
  **Shift +1 week** (immediate `PATCH /api/phases/[id]`, no
  intermediate step), **Book trade** (expands the edit panel AND
  auto-opens its existing `AddVisitForm` inside `VisitsPanel` via a
  `forceOpenAddVisit` prop plumbed down from `GanttChart` →
  `PhaseRow` → `PhaseEditPanel` → `VisitsPanel`, so "booking a trade"
  from the menu lands directly on the same add-visit mini-form staff
  already use, pre-scoped to that phase), **Change colour** (submenu of
  the 4 `color_key`s, reuses the same `COLOR_SWATCH`/`COLOR_KEYS`
  constants the edit panel's colour picker already uses).
- **"Mark complete" — SKIPPED, not implemented.** `schedule_phases` has
  no complete/status column; a phase's only date-shaped state is
  `start_date`/`end_date`, and "done" is inferred client-side
  (`end_date < today`, see `GanttChart.tsx`'s `completedPhases`) rather
  than stored. Adding a real status column would need a new migration,
  which is outside this round's explicit "NO new migration for your
  half" boundary — documented here and inline in `GanttChart.tsx`
  rather than silently omitted.
- Right-click empty timeline space (a week-header cell) → **Add phase
  starting this week**, which prefills the existing `AddPhaseForm`'s
  start-date field with the right-clicked week's Monday date (via a new
  optional `initialStart` prop) rather than inventing a second add-phase
  entry point.
- Touch: long-press (~500ms, `LONG_PRESS_MS`) on a phase bar opens the
  same menu (`onTouchStart` arms a timer, cleared on
  `touchend`/`touchmove`/`touchcancel` so a normal tap/scroll never
  triggers it).

**Tab bar polish** (`components/projects/ProjectTabs.tsx`) — converted
to a client component (`"use client"`) so it can render a single
sliding underline indicator (absolutely-positioned `<span>`,
`transform: translateX` + `width` transitioning over 200ms ease-out,
GPU-composited) instead of every tab drawing its own static
`border-b-2`. Measured via refs on mount, on `active` change, and via a
`ResizeObserver` on the tab row (catches viewport/admin-tab-visibility
changes). Hover colour transitions over 150ms; the active tab's label
renders at `font-medium` (the base `text-subhead` utility is
font-weight 300 — "light" — so the active tab now visibly reads
heavier, not just underlined). Verified all 11 call sites (every
project sub-page) pass only serialisable props
(`projectId`/`active`/`isAdmin`/`portalUrl` — strings and a boolean),
so nothing breaks crossing the client-component boundary; the
`PortalLinkAction` slot (already its own `"use client"` component)
keeps working unchanged as a plain child. No `position: sticky` or
backdrop-blur was added — verified this bar renders in normal document
flow (directly after `<Header>`) on every call site with no sticky
ancestor, so per this round's brief that entire treatment was skipped
rather than manufactured.

## Round B — takeoff → FF&E quantity links, materials, calculators

Migration `027_quantity_links_materials.sql`. BUILD-SPEC.md "Pricing
division — Estimates = labour, FF&E = products" (takeoff→FF&E links
half) + "Phillip's ideas list — 6 July 2026" item 4 (calculators incl.
materials price list).

### Items gain a measurement link

`items` gains `measurement_id` (nullable uuid, references
`measurements`, `on delete set null`), `wastage_pct` (nullable
numeric(5,2), 0–50 check), `coverage_per_unit` (nullable
numeric(10,4)) — mirrors `cost_lines.measurement_id`/`wastage_pct`
(migration 009) so a spec-register item's quantity can be DERIVED from
a linked measurement instead of hand-typed, same UX already proven for
estimate cost lines. See `lib/item-quantity.ts` `derivedQuantity()`:
`measurement.value * (1 + wastage_pct/100)`, then `ceil(that /
coverage_per_unit)` if `coverage_per_unit` is set, else used as-is.

- **`PATCH /api/items/[id]`** — Auth: session. Whitelist gains
  `measurement_id`, `wastage_pct`, `coverage_per_unit` (not financial,
  team-editable, no admin-gating). `wastage_pct` is bounds-checked
  0–50 server-side (`400` on out-of-range) ahead of the DB check
  constraint, same pattern `item_code`'s format validation already
  uses. **Aria-relevant** (same route she already calls for other item
  fields).
- **`GET /api/items/[id]`** and **`GET /api/projects/[id]/items`** —
  both now embed the linked measurement as `linked_measurement: { id,
  label, value, unit } | null` on every item row (PostgREST nested
  select, same `measurements(...)` embed pattern
  `GET /api/projects/[id]/estimate` already uses for
  `measurement_groups(name)`). Team-visible on both routes — not
  admin-gated, since the embed is just the plain
  `label`/`value`/`unit` columns, not a financial figure.

### FF&E rollup — derived quantity, additive

`lib/estimate.ts` `ffeRollup(items, measurementsById?)` gains an
OPTIONAL second parameter (Round A didn't touch this file; Round B
edited it additively). When an item's `measurement_id` resolves against
the supplied map, its FF&E line total uses the same derived-quantity
formula as `lib/item-quantity.ts`, instead of the raw `quantity`
column. Every existing caller that omits the second argument (or whose
items have no `measurement_id`) computes byte-for-byte the same result
as before this round — fully backwards compatible.
`GET /api/projects/[id]/estimate` now selects
`measurement_id, wastage_pct, coverage_per_unit` alongside the existing
item columns and passes the same `measurementsById` map already built
for cost-line `effectiveQty()` into `ffeRollup()` too.

### Materials — `/api/materials`

Global (not per-project) price list for the Calculators feature —
`materials` table: `name` (required), `product_url`, `unit` (default
`'ea'`), `price`, `price_refreshed_at`, `coverage_per_unit`, `notes`,
`created_by`, timestamps, `deleted_at`.

- **`GET /api/materials`** — Auth: session. `?q=` filters by name
  (case-insensitive partial match). Returns `{ materials: Material[] }`,
  non-deleted only, ordered by name.
- **`POST /api/materials`** — Auth: session. Body: `{ name, product_url?,
  unit?, price?, coverage_per_unit?, notes? }`. `name` required (`400`
  otherwise). Returns `201 { material }`.
- **`GET /api/materials/[id]`** — Auth: session. `404` if not found/deleted.
- **`PATCH /api/materials/[id]`** — Auth: session. Whitelist: `name`,
  `product_url`, `unit`, `price`, `coverage_per_unit`, `notes`. A hand
  edit to `price` clears `price_refreshed_at` (the price is no longer
  "as of the last refresh" once someone types over it).
- **`DELETE /api/materials/[id]`** — Auth: session. Soft-delete
  (`deleted_at`), same convention as items/cost_lines/variations.
- **`POST /api/materials/[id]/refresh-price`** — Auth: session. Reuses
  the SAME SSRF-guarded fetch (`lib/scraper/guard.ts` `fetchSafely`) and
  HTML extraction (`lib/scraper/extract.ts` `extractFromHtml`) the item
  scrape pipeline already uses, against `materials.product_url`.
  **`400`** if the material has no `product_url`. Otherwise ALWAYS
  `200`, never a scrape-failure error — per BUILD-SPEC.md "failures
  flag, never block": `{ material, ok: boolean, note?: string }` —
  `ok: false` with a `note` (e.g. "No price found on the product
  page.", "Product URL points to a disallowed address.") on any
  scrape failure, `ok: true` + the updated `material` (new `price` +
  `price_refreshed_at`) on success.

Materials are team-visible reference data (same visibility class as
`library_items`/`items.price_rrp`, not gated like `items.price_trade`)
— the Calculators tab that uses them is itself already admin-gated one
level up (mounted inside the Estimate workspace, which is admin-only —
see `app/(dashboard)/projects/[id]/estimate/page.tsx`), so this route
does not re-check admin itself.

### Calculators — client-side math, no calculator API

BUILD-SPEC.md item 4(a)/(b): timber frame + plasterboard calculators.
**All math is pure and client-side** (`lib/calculators.ts`) — there is
no `/api/calculators/**` route; the only network calls a calculator
component makes are the existing `/api/materials/**` routes above (for
the linked material + refresh-price) and, on "Insert as estimate line",
the EXISTING `POST /api/estimate/sections/[sectionId]/lines` route
(unchanged — the calculator just composes a `description`/`notes`
body and posts to it, same as the Estimate tab's own "add line" UI).

`lib/calculators.ts` exports (all pure, unit-testable, no
Supabase/Next imports): `studCount`, `nogginRowCount`,
`timberFrameMembers`, `binPackLengths` (greedy first-fit-decreasing
bin packing onto `[2.4, 2.7, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0]` metre stock
lengths), `timberFrameCutLengths`, `calculateTimberFrame`,
`netWallAreaM2`, `sheetAreaM2`, `calculatePlasterboard`,
`timberFrameLineDescription`, `plasterboardLineDescription`. Per
Phillip's 6 July DECISIONS paragraph (item 4, "NO framing defaults"):
every calculator input starts empty/null in the UI — no stud spacing,
sheet size, or any other value is pre-filled.

New UI: `components/calculators/CalculatorsPanel.tsx` (mounted as a new
"Calculators" tab in `components/estimate/EstimateWorkspace.tsx` —
Round A didn't touch that file's tab strip; this round added a tab
additively), `TimberFrameCalculator.tsx`, `PlasterboardCalculator.tsx`,
`MaterialLinkControl.tsx` (shared "link material" select + inline add +
refresh-price button, used by both calculators).

### Known gap — no `list_materials` Aria tool yet

Documented, not built this round — see `docs/ARIA.md`'s matching note.

## Three from Phillip — 6 July 2026 evening

Migration `028_job_numbers.sql`. No other concurrent-agent boundary
issues — this round only touched files this task's brief explicitly
scoped (job numbers, My Work focus deep-links, grouped-list add-task).

### 1. My Work focus deep-links

Every My Work item that links into a page with a real row/card to
target now appends `focus=<kind>-<id>` to its `href` (built in `GET
/api/my-work` — see `app/api/my-work/route.ts`; `lib/my-work.ts` itself
only does bucketing, not href construction, so this round's edits live
entirely in the route). Two lead-in styles depending on whether the
existing href already had a `?`: `?focus=...` (board_task, office_task,
design_task) or `&focus=...` (diary_draft, decision_overdue,
trade_proposal — both `?tab=` already present).

Not wired (no natural row exists on the target page to focus): `lead_follow_up` (`/leads`), `insurance_expiring` (`/contacts`).

**Mechanism** — `components/shared/FocusOnLoad.tsx` (new, mounted once
in `app/(dashboard)/layout.tsx` alongside `ScrollMemory`, inside the
same `<Suspense>` boundary): reads `?focus=` via `useSearchParams`,
looks up `document.getElementById(`focus-${focus}`)`, and after a
double `requestAnimationFrame` (let the page paint first) calls
`scrollIntoView({ block: "center", behavior: "smooth" })` plus a 2s sand
(`#A08C72`) outline pulse (inline styles, no new CSS), then
`router.replace()`s the URL with `focus` stripped but every other query
param preserved. **Focus must win over ScrollMemory**: `components/
shared/ScrollMemory.tsx` was edited to skip BOTH its restore-on-mount
and its scroll-listener attach whenever `?focus=` is present in the
current search params — simplest coordination point, no shared
state/context needed between the two components.

**Ids added** (each row/card gained a matching
`id={`focus-<kind>-<id>`}` attribute; none of these components had any
`id` attribute on their rows before this round):
- `board_task` — `components/board/ProjectBoard.tsx`: kanban `BoardCard`
  root `<div>` (used by both the stacked and side-by-side kanban
  layouts) AND the grouped-list `GroupRows` `<tr>` — only one of the
  two is ever mounted at a time (view toggle), so no id collision.
- `office_task` — `components/office/OfficeBoard.tsx` `TaskRow` root `<div>`.
- `diary_draft` — `components/client-area/DiaryPanel.tsx`
  `DiaryApprovalCard` root `<div>` (the "Ready to publish" card, which
  is also reused on the project overview hub per that component's own
  doc comment).
- `trade_proposal` — `components/gantt/GanttChart.tsx` `VisitRow`
  (`<li>`, inside a phase's Trade visits edit panel). **Known
  limitation**: the phase edit panel that contains this row is
  collapsed by default — if the relevant phase isn't already expanded,
  `FocusOnLoad` will find no matching element and silently no-op
  (scrollIntoView/outline pulse simply don't happen; no error). Not
  fixed this round — `GanttChart.tsx` has no existing
  "auto-expand phase N" hook to wire into without a riskier change to
  an already-dense file with live drag/resize slider logic.
- `design_task` — `components/projects/design/DesignPhaseSection.tsx`
  `DesignTaskRow` root `<div>`.
- `decision_overdue` (item register) — **interim**, see
  `docs/HANDOFF-focus-register.md`: `SpecRegister.tsx` is protected this
  round, so the id was added to `components/items/ProcurementView.tsx`
  (Pricing & Procurement view) instead, and
  `components/items/ProjectWorkspace.tsx` gained an `initialView` prop
  (computed server-side in `app/(dashboard)/projects/[id]/page.tsx`
  from `searchParams.focus`) so the FF&E tab opens straight into the
  Procurement sub-view for this one focus kind — otherwise the view
  still defaults to "Spec" and the row would never mount.

### 2. Auto job numbers

See the updated `POST /api/projects` and `PUT /api/projects/[id]`
sections above for the route contract. Summary of what else changed:

- **Migration `028_job_numbers.sql`** — `projects.job_number` (text,
  nullable), partial unique index on non-null/non-deleted rows
  (`idx_projects_job_number_active`). Backfill: every project gets a
  sequential 3-digit zero-padded number in `created_at` order, EXCEPT
  the project named "Goldsworthy" (case-insensitive) is set to `026`
  first and excluded from the sequence — per Phillip, that's their real
  pre-existing job number, not a placeholder.
- **`lib/job-number.ts`** — `nextJobNumber(supabase)`: reads every
  project's `job_number` (including archived — a number once issued is
  never reissued), ignores non-numeric legacy values defensively, takes
  the max + 1, zero-pads to 3 digits (naturally becomes 4 digits once
  the sequence passes 999, since `padStart` only pads up to the target
  width). Also exports `JOB_NUMBER_PATTERN` (`/^\d{3,4}$/`) reused by
  both the settings-form client-side check and the PUT route's
  server-side validation.
- **Both project-creation paths** generate a number: `POST
  /api/projects` and `POST /api/leads/[id]/create-project`. Both retry
  once on a `23505` unique-violation race.
- **Settings**: `components/settings/ProjectSettingsForm.tsx` gained a
  "Job number" field next to Alias — validates `^\d{3,4}$` client-side,
  surfaces a 409 clash inline under the field (not just the shared
  error banner).
- **Display**:
  - Project header (`components/layout/Header.tsx`) — new `jobNumber`
    prop, rendered muted (`text-charcoal/40`) immediately before
    `titleSuffix` (alias), same styling, so the two read as one
    metadata cluster next to the title. Wired at
    `app/(dashboard)/projects/[id]/page.tsx`.
  - Dashboard `components/projects/ProjectCard.tsx` — small `#026` next
    to the item count in the card's bottom metadata row.
  - `components/pdf/SchedulePdf.tsx` — cover (`Project No. 026` line in
    the meta block) and footer (`/  Project No. 026` appended to the
    existing left-side line). `Props.project` widened via an inline
    intersection (`& { job_number?: string | null }`) since
    `types/index.ts` is out of this round's edit boundary. The PDF
    route's cache key (`app/api/projects/[id]/pdf/route.ts`) now also
    folds in `job_number` so a renumbered project never serves a stale
    cached PDF showing the old number.
  - `components/pdf/SowPdf.tsx` cover's existing "Project No." field —
    previously always the first 8 characters of the project's UUID
    (`app/api/projects/[id]/sow/[sowId]/pdf/route.ts`'s `projectNo`
    constant, with a doc comment flagging it as a stand-in pending a
    real numbering scheme). Now prefers `project.job_number`, falling
    back to the old UUID-prefix behaviour only if `job_number` is still
    null (shouldn't happen post-backfill, but costs nothing as a
    defensive fallback).
- **Types**: `job_number` added to `ProjectWithAlias` /
  `ProjectWithCountsAndAlias` in `types/phase-12a-b.ts` (not
  `types/index.ts` — same file-boundary convention `alias` itself
  already established there).

### 3. Grouped-list add-task

**Finding**: audited before building — the grouped-list view
(`GroupTable` in `components/board/ProjectBoard.tsx`) had NO inline
add-task composer of any kind; the only "add" affordance in that view
was the page-level "+ Add phase" button, which creates a new group, not
a task. Both kanban layouts (stacked and side-by-side) already had
their own separately hand-rolled composers — there was no shared
`AddCard` component to reuse verbatim, so this round added a new
composer directly inside `GroupTable`, matching the simpler of the two
existing ones (`StackedColumnSection`'s title-only input, no assignee
picker — the grouped-list rows are already dense with
title/assignees/contact/due/status/phase columns, so a minimal composer
keeps the footer from competing with the table for attention).

**Wiring**: `addTask()` (this file's single task-creation mutator)
gained a 4th optional `phaseGroupId` param — every existing call site
(both kanban composers) omits it, so their behaviour is byte-for-byte
unchanged. When provided, the POST body includes `phase_group_id` (the
board API, `POST /api/projects/[id]/board`, already accepted this field
via `CreateBoardTaskInputV2` — no route change needed) and the new task
is appended into BOTH `columns` state and `groups` state client-side, so
it appears immediately in the grouped list without a reload. The new
composer's caller resolves "default column" as `columns[0]?.id` (the
first status column, by server-query order) — this is a new concept in
this file; previously nothing needed a "default column" shortcut.
Auto-assigns to the creator (`currentUserId`, threaded into `GroupTable`
as a new prop), same "assign the creator unless overridden" convention
`StackedColumnSection` already used.

## Board cockpit round — 7 July 2026

Migration `029_board_cockpit.sql`. BUILD-SPEC.md "Board refinement
batch (Phillip screenshots, 7 July 2026)" + four chat-agreed
improvements: book-trade-from-card, milestone cards, phase task
templates, Aria booking-chase attention feed, plus two-dates-per-card,
a shared searchable ContactPicker, Gantt tick markers, and the
Bunnings/blocked-site pricing loop.

### `board_tasks` additions

`kind` (`'task'` default | `'milestone'`), `visit_id` (nullable FK to
`trade_visits`, `on delete set null`), `booking_date`/`booking_end_date`
(date, nullable — the booked trade-visit window, denormalized copies of
the linked visit's own `start_date`/`end_date`, distinct from
`due_date`). See migration 029's own comments for the full "why
denormalized" rationale. Kept in sync at exactly two write sites:
`POST .../book-visit` below (creates/links) and `PATCH /api/visits/[id]`
(already existed — now additionally pushes `booking_date`/
`booking_end_date` onto any linked `board_tasks` row whenever the
visit's own dates change, e.g. a Timeline drag).

### `materials` additions

`price_refresh_status` (nullable text, only allowed non-null value
`'needs_aria'`) + `price_refresh_requested_at` (nullable timestamptz) —
see "Bunnings/blocked-site pricing" below.

### Book trade from a board card

- **`POST /api/board-tasks/[id]/book-visit`** — Auth: session. Body
  EITHER `{ phase_id, start_date, end_date, contact_id?, arrival_slot?,
  arrival_time?, notes? }` (creates a new `trade_visits` row, same
  required fields as `POST /api/projects/[id]/visits`) OR
  `{ existing_visit_id }` (links to an already-booked visit from the
  same project, not already linked to a different card). `400` if the
  card already has a booking (unlink first). `404`/`400` on bad
  phase/contact/visit references, same validation as the Timeline's own
  add-visit form. Returns `201 { task: BoardTaskCockpit, insurance_warning:
  string | null }` — `task` includes the freshly-set `visit_id`/
  `booking_date`/`booking_end_date` AND a joined `visit` summary (id,
  status, dates, contact) so the card's status badge renders
  immediately without a second fetch.
- **`DELETE /api/board-tasks/[id]/book-visit`** — Auth: session. Clears
  `visit_id`/`booking_date`/`booking_end_date` on the card WITHOUT
  deleting the underlying `trade_visits` row (the visit may still be a
  real booking on the Timeline — this only removes the card's link to
  it). Returns `{ task }`.
- **`GET /api/projects/[id]/board`** — unchanged route, richer response:
  every task now carries `kind`, `visit_id`, `booking_date`,
  `booking_end_date`, and (when `visit_id` is set) a joined `visit: {
  id, status, start_date, end_date, contact }` summary — batch-fetched
  alongside the existing assignee/contact joins (no N+1).
- **`POST /api/projects/[id]/board`** (create card) and
  **`PATCH /api/board-tasks/[id]`** — both gain an optional `kind`
  field (`'task'` default | `'milestone'`) on top of their existing
  bodies. `booking_date`/`booking_end_date`/`visit_id` are NOT
  independently PATCHable here — only ever set via the book-visit route
  above or cleared via its DELETE, so a card's booking state always has
  one auditable write path.

### Milestone cards

`kind: 'milestone'` cards render as a diamond marker (kanban card,
grouped-list row, and Gantt timeline — see below) instead of an
ordinary card shape. When a milestone card moves into a Done-like
column (matched by column NAME — "done"/"complete"/"completed",
case-insensitive — not a fixed `column_id`, since column sets are
per-project/editable; see `lib/board-cockpit.ts`
`shouldPromptMilestoneDiary()`), the UI offers a dismissible prompt
("Start a diary draft?") that POSTs a bare `portal_updates` draft via
the existing `POST /api/projects/[id]/client-updates/posts` route,
pre-filled with the milestone's title. Dismissing is a no-op (local
component state only, no schema) — the milestone still completes
either way; this is a nudge, not a workflow gate.

### Aria booking-chase attention feed — `bookings_overdue`

- **`GET /api/board-tasks/attention`** — Auth: session, no admin gate
  (scheduling data). Returns `{ bookings_overdue: BookingsOverdueItem[]
  }` — cards matching either: a `booking_date` in the past with the
  linked visit still `unconfirmed`/`tentative`/`proposed_change`
  (reason `booking_unconfirmed`), or a `kind: 'milestone'` card with an
  overdue `due_date` (reason `milestone_overdue`, only when the first
  reason doesn't already apply). See `lib/board-cockpit.ts`
  `computeBookingsOverdue()` for the exact rule. Each item carries
  `task_id`, `title`, `project_id`, `project_name`, `reason`, `date`,
  `visit_status`, `contact`.

### Phase task templates — `app_settings('phase_task_templates')`

Second `app_settings` key alongside the existing `phase_template`
(migration 023) — same table, no new schema. Shape: an object keyed by
phase-template NAME (matching `phase_template` row names, e.g.
`"Demolition"`) → array of `{ title, kind: 'task' | 'milestone' }`.
Seeded with one default checklist for `"Site Setup"` (site fencing,
site toilet, skip bin, site signage — the same "site establishment,
fencing, amenities, skips" list BUILD-SPEC.md's own umbrella-phase note
already describes) — every other phase name starts with no checklist.

- **`GET /api/settings/phase-task-templates`** — Auth: session (team-
  visible, studio config, not financial). Returns `{ templates:
  PhaseTaskTemplatesMap }`, `{}` fallback if the row is missing.
- **`PUT /api/settings/phase-task-templates`** — Auth: admin only
  (mirrors `PUT /api/settings/phase-template`'s gating). Body: `{
  templates }`, full replace. Validates every phase name is non-blank,
  every row has a non-empty `title` and `kind` in `('task',
  'milestone')`. Does NOT retroactively touch any already-seeded
  project.
- **Seed-time consumption**: `lib/phase-seed.ts`
  `seedPhaseTemplateIfEmpty()` (the shared seed path — GET
  `/api/projects/[id]/phases`, the Timeline page's first load, and POST
  `/api/projects/[id]/board/groups/seed`) now ALSO reads
  `phase_task_templates` alongside `phase_template` and, for each
  seeded phase whose name has a non-empty checklist, creates one
  `board_tasks` row per checklist item — unassigned, no due date,
  `phase_group_id` set to that phase's just-created group, using the
  project's first `board_columns` entry (seeding a minimal "Waiting"
  column first if none exist yet). Missing/empty checklist for a phase
  name is a no-op for that phase.
- **Settings UI**: `components/settings/PhaseTaskTemplateSettings.tsx`
  (mounted in `app/(dashboard)/settings/page.tsx`, directly below the
  existing `PhaseTemplateSettings` section) — one tab per phase name,
  each with its own ordered task list (title + kind), add/reorder/
  delete, same interaction shape as `PhaseTemplateSettings.tsx`.

### Two dates per card + grouped-list edit parity

Kanban card and grouped-list row both show a sand-coloured booking chip
("📅 21 Jul" or "📅 21–22 Jul" for a range, plus the linked visit's
status when present) and a due chip (red when overdue), sourced from
the SAME `GET /api/projects/[id]/board` response — no per-view
divergence. Both views' full card editor is now the SAME shared
component (`BoardTaskEditorBody` in `components/board/ProjectBoard.tsx`)
— clicking a grouped-list row expands it inline (a `colSpan` sub-row),
exposing description, assignees, "Due (to-do)" date input, "Booking
date (works)" (read-only display + Book trade/Unlink booking actions —
see the single-write-path note above), contact picker, milestone
toggle, and Remove card — identical fields/behaviour to the kanban
card's expand-in-place editor, previously a much thinner due/status/
phase-only set of inline cells.

`GET /api/my-work` source #1 (board tasks assigned to me): when a task
carries a `booking_date`, its `title` gains an additive
`" — works <DD/MM>"` suffix (e.g. "Book carpenter — works 21/07");
unchanged when `booking_date` is absent.

### Shared searchable ContactPicker

`components/shared/ContactPicker.tsx` — button+dropdown (or `embedded`,
an always-open inline mode with no trigger button) contact picker with
a search box, "No link" clear option, and full keyboard nav
(ArrowUp/ArrowDown moves a highlighted row, Enter selects it — or the
top match if nothing's been arrow-key-touched yet — Escape closes).
Fetch-strategy decision (documented in that file's own header comment):
does NOT fetch `/api/contacts?q=` itself — callers fetch the global
list ONCE and hand it down; studio contact counts are small enough that
client-side filtering is simpler than per-keystroke debounced fetches.
Wired at: the board card editor (kanban + grouped-list, both via
`BoardTaskEditorBody`), `BookVisitPanel.tsx`, `GanttChart.tsx`'s
`PhaseEditPanel` (phase-level contact) and `AddVisitForm` (the
Timeline's own booking form — previously a plain `<select>`),
`components/estimate/ContactLinkPicker.tsx` (now a thin wrapper in
`embedded` mode), and `components/items/SupplierContactPicker.tsx` (now
wraps it internally, preserving its supplier/supplier_email autofill
side-effect exactly).

### Gantt timeline tick markers + Day/Week/Month zoom

`components/gantt/GanttChart.tsx` renders sand ticks (3px wide) on each
phase row at every linked board-task's `due_date` (shorter, duller —
`h-3`, `charcoal/50`) and `booking_date` (taller, full-strength sand —
`h-5`), plus milestone diamonds at `kind: 'milestone'` tasks' own
`due_date`. Absolutely positioned, in a layer that sits alongside (never
on top of, except its own 3px click target) the phase bar's drag/resize
surface — the drag/resize pointer handlers and `lib/gantt.ts`'s grid
math are completely unmodified by this round; markers reuse the exact
same `phaseGridPosition()` on a synthetic single-day range. Hovering
shows a tooltip (title + "Due"/"Booking"/"Milestone"); clicking
navigates to `/projects/[id]/board?focus=board_task-<id>` (the same
`?focus=`/`FocusOnLoad` mechanism the My Work feed's board-task links
already use). Markers are supplied by the Timeline page
(`app/(dashboard)/projects/[id]/timeline/page.tsx`), joined server-side
via `board_groups.phase_id`.

Zoom: an always-visible Day/Week/Month toggle (previously Week/Month
only, and only shown above a 12-week span) — Week stays the fixed
default. Every level reuses the SAME week-column grid (`lib/gantt.ts`
untouched); "day" and "month" only change the CSS column min-width
(wider for day, narrower for month) plus, in day mode, adds decorative
day-of-week initials under each week's header label. The grid wrapper's
existing horizontal scroll (`overflow-x-auto`) is what makes Day mode
usable — this is the one place in the app horizontal scroll is the
expected interaction. Drag snapping stays day-grain at every zoom level
(unaffected — `columnPx` is measured from the actual rendered grid
width at drag-start, so widening/narrowing columns changes what that
measurement returns, never the snap formula). The read-only portal
mirror (`components/portal/TimelineSection.tsx`) is untouched and stays
fixed at week-mode — it imports the same unmodified `lib/gantt.ts`
functions.

### Bunnings/blocked-site pricing — `materials.price_refresh_status`

`bunnings.com.au`/`wilbrad.com.au` are VERIFIED to hang on a plain
server-side fetch. `POST /api/materials/[id]/refresh-price` (unchanged
request/response shape — see "Round B" above) now, on ANY failed
refresh (bad fetch, non-HTML response, or no price found), additionally
sets `price_refresh_status: 'needs_aria'` + `price_refresh_requested_at:
now()`. A successful refresh (or any `PATCH /api/materials/[id]` that
includes `price`) clears both back to `null` — a hand-entered or
Aria-submitted price resolves the outstanding request the same way a
successful scrape would.

- **`GET /api/materials/attention`** — Auth: session, no admin gate.
  Returns `{ price_refreshes_pending: MaterialNeedingAriaItem[] }` —
  every material currently `needs_aria`, each with `material_id`,
  `name`, `requested_at`.
- **Materials UI** (`components/calculators/MaterialLinkControl.tsx`) —
  shows a "Waiting for Aria" caption (with the request date) on any
  linked material in this state.

### MCP additions

`mcp/src/index.mjs` gains four tools:

- **`get_bookings_overdue`** — thin fetch to `GET
  /api/board-tasks/attention`.
- **`book_trade_visit({ task_id, phase_id, contact_id?, start_date,
  end_date, arrival_slot?, arrival_time?, notes? })`** — thin fetch to
  `POST /api/board-tasks/[id]/book-visit`. Booking EXECUTION (not just
  drafting) is deliberately allowed here — see `docs/ARIA.md`'s "Board
  cockpit round" section for the full reasoning (trades confirm
  themselves; nothing becomes final until they do).
- **`get_materials_needing_aria`** — thin fetch to `GET
  /api/materials/attention`.
- **`submit_material_price({ material_id, price, source_note? })`** —
  thin fetch to `PATCH /api/materials/[id]` with `{ price, notes:
  source_note }`. `source_note` REPLACES the material's `notes` field
  (a single flat field, not an append-only log).

### Timber frame calculator — "Double studs each side of openings"

`lib/calculators.ts` `TimberFrameInputs` gains
`double_studs_at_openings: boolean` (off by default). When true,
`timberFrameMembers()` adds `opening_doublers = openingCount * 2` — 2
extra FULL-HEIGHT studs per opening (one doubler per side), IN ADDITION
to that opening's existing jack-stud/lintel members (doublers and jack
studs are different members: a doubler carries load either side of a
large opening at full wall height; a jack stud is shorter, supporting
the lintel at the opening's head height). Flows through
`timberFrameCutLengths()` (full-height pieces, same as ordinary studs)
into `binPackLengths()`/`calculateTimberFrame()`'s cost — not just added
to the display list. UI: `components/calculators/TimberFrameCalculator.tsx`
gains the toggle (next to "Double top plate") and a member-list line
("Opening doublers · 2 per opening") shown only when the count is > 0.

## Round — trade visit sub-bars, plasterboard $/m², design task templates (7 July 2026)

No new migration this round — every item below is rendering,
derivation, or `app_settings` (existing key/value table). Verified: the
protected files list (`lib/supabase/middleware.ts`, `vercel.json`,
`app/api/digest/**`, `components/items/SpecRegister.tsx`/
`RoomAssignBar.tsx`/`RoomBuilder.tsx`/`ItemRoomsEditor.tsx`, `lib/csv.ts`,
`app/api/projects/[id]/import/**`, `types/index.ts`) was left untouched.

### Internal timeline — trade visit sub-bars

`components/gantt/GanttChart.tsx`'s `PhaseRow` gains an expand/collapse
chevron (shown only when the phase has ≥1 visit) revealing one thin
sub-row per `trade_visit`, rendered as a genuine second CSS grid row
beneath the phase's own bar row (col 1 = blank sticky spacer, col 2 =
`2 / span weekCount`, matching the phase bar's own grid-column span
exactly) — declined visits are excluded. Auto-expanded at Day zoom
(`isExpanded = zoom === "day" || !!expanded[phase.id]`); otherwise the
per-project state persists to `localStorage` under
`reslu:gantt:visit-expansion:<projectId>` (see `GanttChart.tsx`'s
`loadVisitExpansion`/`saveVisitExpansion` — a pure client preference,
never written to the server).

**`components/gantt/VisitSubBar.tsx`** (new) renders each sub-bar,
positioned via `lib/gantt.ts`'s existing `visitGridPosition()` — the
SAME grid math phase bars use (`visitGridPosition` is a thin wrapper
around `phaseGridPosition`, unchanged this round). Status styling:
`confirmed` = solid charcoal fill; `unconfirmed`/`tentative` = dashed
sand border, no fill; `proposed_change` = amber fill (`#B98A4A`, the
same swatch as an amber phase). Day zoom shows `"{company} ·
{arrival}"` directly on the bar; Week/Month show the same detail (plus
finishes date, status, notes) in a hover `title` tooltip instead
(bars are too narrow at those zooms for on-bar text). Clicking a
sub-bar (a plain click, not a drag — see below) opens the existing
`VisitBottomSheet` (unchanged component, already used for the mobile
tap-a-dot flow), same as every other visit-detail entry point in this
app.

**Drag/resize** reuses `lib/phase-drag.ts`'s `applyDrag`/
`snapDeltaDays` — the exact same pure functions phase-bar dragging
already uses, not a fork. `GanttChart.tsx` gains `patchVisit` (PATCH
`/api/visits/[id]`, optimistic, byte-for-byte the same
optimistic-update/revert-on-failure shape as `patchPhase`),
`commitVisitDrag`, and `startVisitDrag` (a pointermove/pointerup pair on
`document`, measuring `columnPx` from the same `gridBodyRef` phase bars
use) — a parallel `visitDragState` (separate from the existing
`dragState`, since a visit id is never a phase id) so phase-bar dragging
is completely untouched. Phase-bar drag paths were verified unchanged —
`dragState`/`startDrag`/`commitDrag`/`patchPhase` still read exactly as
before this round.

**"Dates changed — re-send confirmation?"** — BUILD-SPEC: "if the visit
was `confirmed`, after a successful date change show a non-blocking
affordance ... re-confirmation NOT auto-triggered on drag." `startVisitDrag`
captures `wasConfirmed = visit.status === 'confirmed'` at drag-start;
`commitVisitDrag` shows `components/gantt/ReconfirmAffordance.tsx` (new,
a small dismissible strip under the sub-bar) only when that PATCH
actually changed the dates AND `wasConfirmed` was true.

**State-machine finding** (see
`app/api/visits/[id]/resend-confirmation/route.ts`'s own doc comment
for the full trace): this codebase has no prior "re-send confirmation"
mechanism — and, more surprisingly, no "send initial confirmation
request" email either. `POST /api/projects/[id]/visits` (create) sends
nothing; the only two places `trade_visits` ever emails a contact are
`POST /api/visits/[id]/resolve-proposal` (accept/counter a trade's own
proposed date) and the once-only `GET /api/trade-reminders` cron (fires
1–2 days before `start_date`, gated by `reminder_sent_at IS NULL`,
never for an already-`confirmed` visit). So "wire the same send used at
creation" has no literal target. **New route: `POST
/api/visits/[id]/resend-confirmation`** — callable only when
`status === 'confirmed'` (400 otherwise); on success, resets
`status → 'unconfirmed'`, clears `confirmed_at`/`confirmed_by` (they
described the now-superseded confirmation) and `reminder_sent_at` (so
the cron can nudge again if the trade doesn't respond to this
immediate resend); sends one email immediately (unconditional, no
`reminder_sent_at` gate — reusing `trade-reminders`' own email
template/tone, the closest existing content to "the same send used at
creation") via the existing `sendTeamEmail`, fire-and-forget (a Gmail
failure never blocks the status reset, matching every other
`trade_visits` email site's identical choice). Response: `{ visit }`.

Portal `TimelineSection.tsx` is verified untouched and unaffected — it
consumes `PortalPhase` (`types/index.ts`), which has no `visits` field
at all; it was never imported into and never imports from
`GanttChart.tsx`, `VisitSubBar.tsx`, or `lib/phase-drag.ts`.

### Plasterboard $/m² derivation

`lib/calculators.ts` gains `sheetRatePerM2(price, sheetSize)` — pure
derivation, `price / sheetAreaM2(sheetSize)`, returns `null` if either
input is missing (no defaults, same rule every calculator function in
this module already follows). `plasterboardLineDescription()` gains an
optional third-arg-equivalent `ratePerM2` param, appending
`"@ $X.XX/m² materials"` to the inserted estimate line's provenance
note when known; omitted entirely (not "@ $?/m²") when `null`.
`components/calculators/PlasterboardCalculator.tsx` computes
`sheetRatePerM2(pricePerSheet, sheetSize)` from its own existing
`sheetSize` select + linked material's price, shows
`"@ $X.XX/m² materials"` in the output summary beneath the
fixings note, and passes it through to the inserted line.

**Limitation (documented in code, not schema)**: sheet size is not a
column on `materials` (migration 027 —
`name/product_url/unit/price/coverage_per_unit/notes` only). The
derivation therefore only ever runs inside `PlasterboardCalculator`,
which already knows the sheet size from its own form state — it cannot
be shown from `MaterialLinkControl`'s materials `<select>` (no
sheet-size context there), and deliberately does NOT infer a rate from
`unit === 'sheet'` + `coverage_per_unit`, since `coverage_per_unit` is a
generic per-material figure used differently across material types and
is not reliably "this sheet's m² area" — see `sheetRatePerM2`'s own doc
comment in `lib/calculators.ts`.

### Design task templates — `app_settings('design_task_templates')`

Structural mirror of the existing `phase_task_templates` key (Board
cockpit round) one phase-model over: an object keyed by Design
Framework phase NAME (`types/phase-12b.ts`'s fixed
`DESIGN_PHASE_TEMPLATE` — Project Milestones / Presentation / Concepts
/ 3D Working Model / WD Package / Renders / Sampling & Furniture) →
array of `{ title }` (no `kind` — `design_tasks` has no
task/milestone concept). New types in `types/round-c.ts`
(`DesignTaskTemplateRow`, `DesignTaskTemplatesMap`, request/response
shapes).

**Seed content** — `lib/design-task-templates.ts`'s
`FALLBACK_DESIGN_TASK_TEMPLATES`, extracted from
`docs/DESIGN-FRAMEWORK-BRIEF.md`'s "What Currently Happens at Each
Phase" section (the real Monday board, board ID 5027297754):

- **Project Milestones**: Initial Consult & Concept Development, Design
  Fee Proposal, Design Development Presentation, Working Drawings for
  Approval, Final WD Design Revision, Construction Scope Of Works.
- **Presentation**: Concept Meeting, Design Development Meeting,
  Working Drawing Presentation, Final Client Review Meeting.
- **Concepts**: Pinterest / mood board direction, 3D concept model,
  Materials board (the brief has no bulleted list for this phase —
  these three are the deliverables named in its prose).
- **3D Working Model**: Base Model, Joinery, Windows & Doors, External
  Works, Appliances, Bathroom, Ensuite, Powder Room, Site Measure.
- **WD Package**: Site & Location Plans, Demolition Plan, Proposed
  Plan, RCP, Electrical Plan, Window & Door Schedule, Internal Glazing
  Elevations, Stone Cutout Plans, Internal Elevations, Wet Area Detail
  Plans & Elevations.
- **Renders**: Bedroom render, Kitchen render, Bathroom render.
- **Sampling & Furniture**: none — the brief states both source Monday
  groups ("Sampling", "Furniture") are "currently empty in the
  template," so this phase seeds with no starter tasks rather than
  inventing a checklist nobody asked for.

These are editable starting points, not a fixed checklist — Settings >
"Design task templates" (mirrors `PhaseTaskTemplateSettings.tsx`) lets
Tenille/Phillip add, reorder, or delete any of these at any time;
editing there never touches an already-seeded project.

- **`GET /api/settings/design-task-templates`** — Auth: session
  (team-visible). Returns `{ templates: DesignTaskTemplatesMap }`,
  falling back to `FALLBACK_DESIGN_TASK_TEMPLATES` (not `{}`) if the
  `app_settings` row is absent, so Settings always shows the extracted
  starting-point checklist even before anyone has ever saved this key.
- **`PUT /api/settings/design-task-templates`** — Auth: admin only
  (mirrors `PUT /api/settings/phase-task-templates`'s gating). Body:
  `{ templates }`, full replace/upsert onto `app_settings`. Validates
  every phase name is non-blank and every row has a non-empty `title`.
- **Seed-time consumption**: `GET /api/projects/[id]/design` — inside
  its existing `phases.length === 0` seed branch (never on a
  subsequent visit), after inserting the 7 `design_phases` rows, reads
  `app_settings('design_task_templates')` (same
  `FALLBACK_DESIGN_TASK_TEMPLATES` fallback as the GET route above) and,
  for each just-seeded phase whose name has a non-empty checklist,
  inserts one `design_tasks` row per item — unassigned, no due date,
  in list order. A phase with no template entry (or an empty one) is
  skipped, best-effort (one phase's insert failing doesn't fail the
  phases that already committed).
- **Delivery mechanism** (mirrors how `phase_task_templates`' own
  defaults were delivered — checked before building this): that
  sibling key's default ("Site Setup" checklist only) came from a
  migration-time SQL `INSERT ... ON CONFLICT DO NOTHING` (migration
  029). This round's explicit "no new migration" boundary means
  `design_task_templates` uses a CODE-LEVEL fallback constant instead
  (`FALLBACK_DESIGN_TASK_TEMPLATES`, read by both the GET route and the
  design-phase seed path when the `app_settings` row is missing) — the
  task brief calls this "acceptable and preferred here." No SQL seed
  was written for this key at all.
- **Settings UI**: `components/settings/DesignTaskTemplateSettings.tsx`
  (mounted in `app/(dashboard)/settings/page.tsx`, directly below
  "Phase task templates") — one tab per fixed Design Framework phase
  name (not itself editable/reorderable, unlike the schedule phase
  template), each with its own ordered title-only task list, add/
  reorder/delete.

## Round — book-visit prefill fix + brick calculator ("Two more — 7 July 2026 evening")

Code-only round, zero new migrations — verified against the existing
`materials`/`board_tasks`/`board_groups` columns (migrations
027/029) rather than adding any.

### Book-trade-from-card prefill fix

**Bug**: opening "Book trade" from ANY board card (desktop kanban card,
Stacked kanban section's row editor, or the Grouped-list row editor —
the daily-driver view, `ProjectBoard.tsx`'s `view` state defaults to
`"grouped"`, matching the mobile screenshot evidence) always rendered
`BookVisitPanel` with phase/trade/start/end completely blank, even
though the card the action was invoked from already carried all four
values.

**Root cause** — two-part, both in the same feature's own files, not a
mobile-only code path (every surface funnels into one shared panel and
one shared piece of state):

1. `components/board/ProjectBoard.tsx` tracked only
   `bookingTaskId: string | null` (now `bookingTask: BoardTaskCockpit | null`)
   — a bare id, with no phase/contact/date context captured at the
   moment "Book trade" was clicked, at any of its four call sites
   (`BoardColumnView`→`BoardCard`, `StackedColumnSection`'s row editor,
   `GroupTable`/`UngroupedTable`→`GroupRows`).
2. `components/board/BookVisitPanel.tsx`'s prop interface had no
   fields to receive that context even if the call site had passed it
   — `phaseId`/`contactId`/`startDate`/`endDate` were `useState("")`/
   `useState(null)` with no initializer input at all.

**Fix**:
- `BookVisitPanel` gained four new optional props —
  `initialPhaseId`, `initialContactId`, `initialStartDate`,
  `initialEndDate` — used as its four `useState` initializers. No
  `useEffect` re-sync was needed: `ProjectBoard.tsx` only ever mounts
  one `BookVisitPanel` at a time (`{bookingTask && <BookVisitPanel key={bookingTask.id} .../>}`)
  and fully unmounts it on close, so a different card's "Book trade"
  click is always a fresh mount with fresh initial props — the `key={bookingTask.id}`
  also guarantees React treats each card's panel as a distinct instance
  even in the (currently impossible, but now future-proofed) case of
  swapping directly from one card's panel to another's without an
  intermediate close.
- `ProjectBoard.tsx`'s `onBookVisit` callback type changed from
  `(taskId: string) => void` to `(task: BoardTaskCockpit) => void` at
  every layer (`BoardColumnView`, `GroupTable`, `UngroupedTable`,
  `GroupRows`) so the full card is available where the panel opens.
  The top-level render site now resolves:
  - `initialPhaseId` — the card's `phase_group_id` (a `board_groups.id`)
    is looked up in the already-loaded `groups` array to find that
    group's own `phase_id` (a `schedule_phases.id` — confirmed the SAME
    id space `BookVisitPanel`'s phase dropdown already populates from
    `GET /api/projects/[id]/phases`, per that route's `board_group_id`
    reverse-lookup/`board_groups.phase_id` FK). `null` when the card is
    ungrouped, which renders as a blank/unselected phase dropdown —
    same as today's behaviour for a card with no phase.
  - `initialContactId` — the card's own `contact_id` directly.
  - `initialStartDate`/`initialEndDate` — the card's own
    `booking_date`/`booking_end_date` (populated when re-booking after
    an unlink; `null` for a never-booked card, same blank-start as
    before).
- **All prefilled values remain plain, editable controlled inputs** —
  nothing is locked/read-only; a user can change the phase, trade, or
  either date before submitting, same as if they'd typed them in
  fresh.
- **Generic/blank-start entry points are unaffected** — this fix is
  entirely additive to `BookVisitPanel`'s prop surface (all four new
  props are optional, defaulting to the exact same blank behaviour as
  before when omitted), so any other future caller that wants a
  from-scratch booking form still gets one.
- The `book-visit` POST body shape (`BookVisitInput`,
  `types/board-cockpit.ts`) is **unchanged** — `bookVisit()`'s own
  fetch call and its `{ phase_id, contact_id, start_date, end_date }`
  body were not touched, only how the panel's OWN form state is
  seeded before the user submits.

**Files touched**: `components/board/BookVisitPanel.tsx`,
`components/board/ProjectBoard.tsx`.

### Brick calculator

New third tab in the Estimate workspace's Calculators panel,
`components/calculators/BrickCalculator.tsx` — third sibling of
`TimberFrameCalculator`/`PlasterboardCalculator`, sharing
`MaterialLinkControl` and the same "insert as estimate line" plumbing
(`CalculatorsPanel.tsx`'s `insertLine()`, unchanged).

**Inputs** (`BrickInputs`, `types/round-b.ts`) — brick length/height/
width mm all start blank (no assumed brick spec — Australian common/
face/metric-modular bricks are genuinely different sizes, so guessing
one would silently produce a wrong bricks-per-m² figure); mortar joint
mm is the one field that DOES start at a default (10mm, the
near-universal standard joint) but stays fully editable; wall length/
height mm; an openings list (width × height each, same
`FrameOpening`/"+ Add opening" UI pattern as the sibling calculators);
wastage % (blank start).

**Formulas** (`lib/calculators.ts`):
- `bricksPerM2(brickLengthMm, brickHeightMm, mortarJointMm)` =
  `1 / ((length_m + joint_m) × (height_m + joint_m))` — a stretcher-
  bond face count (bricks per m² of wall face "as laid"), not adjusted
  for wall thickness/skin count.
- `calculateBrick()`: `net_area_m2` (reuses the existing
  `netWallAreaM2()` helper the plasterboard calc already uses — wall
  area minus openings), `total_bricks = ceil(net_area_m2 × bricks_per_m2 × (1 + wastage_pct/100))`.
- `mortarVolumeM3(netAreaM2, mortarJointMm)` — **honestly approximate,
  documented as such in the code**: `net_area_m2 × 0.02 × (mortar_joint_mm / 10)`,
  i.e. the standard rule-of-thumb ~0.02m³ of mortar per m² of
  single-skin brickwork at a 10mm joint, linearly scaled for a
  different joint width. Explicitly NOT a bed/perpend take-off (this
  calculator doesn't collect wall-thickness/skin-count, which a precise
  figure would need) and NOT adjusted for double-skin/cavity walls
  (roughly double this figure in practice) — the UI surfaces
  `BRICK_MORTAR_NOTE` alongside the number saying exactly this, same
  spirit as `PLASTERBOARD_FIXINGS_NOTE`.
- `brickUnitRate(price, unit)` — unit-aware costing: divides the linked
  material's raw price by 1000 when its `unit` string contains
  `"1000"` or `"thousand"` (case-insensitive substring match, e.g.
  `"1000"`, `"per 1000"`, `"thousand"`) since bricks are commonly sold
  "per 1000"; any other unit is assumed already per-brick. Deliberately
  narrow (not a general unit parser) — an unrecognised unit is treated
  as already-per-brick rather than guessed at, matching
  `sheetRatePerM2()`'s own "don't show a confidently wrong number"
  discipline.
- `brickLineDescription()` — same auto-composed description +
  provenance-note pattern as `timberFrameLineDescription`/
  `plasterboardLineDescription`; "Insert as estimate line" posts
  `qty: total_bricks, unit: "brick", cost_ex_gst: result.cost` to the
  same section-scoped cost-line route every calculator already uses.

**"Request pricing via Aria"** — shown on the linked material whenever
its price is absent (`price === null`) or already flagged stale
(`price_refresh_status === "needs_aria"`, same read
`MaterialLinkControl`'s own "Waiting for Aria" caption uses). Distinct
from that control's own "Refresh price" button (which requires
`product_url` and does a live page scrape) — this is the no-product-
page path for materials that need a genuine supplier quote (bricks
priced per-1000 are the motivating case, but the action isn't
brick-specific in the route itself).

- **`POST /api/materials/[id]/refresh-price?mode=supplier_quote`** —
  the SAME route as the existing scrape-based refresh, extended with
  an optional `mode` query param (no new route file). When
  `mode=supplier_quote`: skips the scrape attempt entirely (no
  `product_url` required in this mode — a bulk/palletised material may
  not have a scrapable product page at all), and writes
  `price_refresh_status='needs_aria'` + `price_refresh_requested_at=now()`
  — the EXACT same two columns (migration 029) the scrape-failure path
  already writes, just reached by a different trigger. Sends a
  distinct email variant via the same `sendTeamEmail` block: subject
  `"Supplier quote needed — {material name}"`, body noting a supplier
  quote is required and surfacing whatever `product_url`/`notes` the
  material record already carries as the closest thing to a supplier
  reference (see the route's own doc comment for why — **no
  `contact_id`/supplier-contact column exists on `materials` at all**,
  confirmed against migration 027; adding one was out of scope for
  this "no new migration" round, so the email asks Aria to source a
  supplier contact herself when neither field is populated, rather
  than inventing a schema field to read one from). Same **once-only
  guard** as the existing path — the pre-update
  `material.price_refresh_status` is checked before sending, so a
  repeat click while already `needs_aria` re-touches
  `price_refresh_requested_at` but does not re-send the email.
- **UI**: `BrickCalculator.tsx`'s own "Request pricing via Aria" button
  (POSTs the above), and — for a row already `needs_aria` — the exact
  same "Waiting for Aria" badge markup `MaterialLinkControl.tsx`
  already renders (that component doesn't care which path set the
  flag), so no visual inconsistency between a brick-triggered request
  and a scrape-failure-triggered one.

**Tab wiring**: `CalculatorsPanel.tsx`'s `CalcTab` union gained
`"brick"`, its tab-button array gained `{ key: "brick", label: "Brick" }`,
and its render ternary gained a third branch rendering
`<BrickCalculator>` with the same five props every sibling calculator
already takes — no other change to that file (materials fetch, insert-
line POST, tab-button styling all reused unchanged).

**Files touched**: `types/round-b.ts` (`BrickInputs`, `BrickResult`,
`CalculatorKind` gained `"brick"`), `lib/calculators.ts`
(`bricksPerM2`, `mortarVolumeM3`, `BRICK_MORTAR_NOTE`, `brickUnitRate`,
`calculateBrick`, `brickLineDescription`),
`components/calculators/BrickCalculator.tsx` (new file),
`components/calculators/CalculatorsPanel.tsx`,
`app/api/materials/[id]/refresh-price/route.ts` (`?mode=supplier_quote`
branch + email variant — same route file, no new route added).

**No schema needed** — verified: brick math needs no new columns
(wastage/wall dims/openings are calculator-local state, not persisted
anywhere), and the supplier-quote request reuses `materials.price_refresh_status`/
`price_refresh_requested_at` (migration 029) exactly as-is. The one
gap this round could NOT fill without a migration — a `materials.contact_id`
linking a material to a supplier contact record — is documented above
and in the route's own doc comment rather than worked around with a
schema change.

---

## Standard spec items + lead notes — migration 030 round (7 July 2026)

BUILD-SPEC.md "Two from Phillip — 7 July 2026 (migration 030 round)"
incl. the per-project checklist amendment. Migration:
`supabase/migrations/030_standards_lead_notes.sql`.

**1. Standard spec items.** `library_items.is_standard boolean not null
default false` (new column). Toggled from the Library UI (badge
'★ Standard' in the list + "Mark standard"/"Unmark standard" button,
`components/library/LibraryBrowser.tsx`) via the `PATCH
/api/library/[id]` whitelist addition (see that route's section
above). `GET /api/library?standard=1` (new filter, same route file)
returns only flagged items — this is what feeds the "Standard spec
items · N" expandable checklist
(`components/projects/StandardItemsChecklist.tsx`), pre-ticked and
individually untickable, rendering nothing at all when no items are
flagged. That checklist appears in two places:
- **Create Project** (`components/projects/ProjectForm.tsx`) — full
  expandable variant; selected ids ride along as `standard_item_ids` in
  the `POST /api/projects` body (see that route's section above).
- **Leads "Progress to job"** (`components/leads/LeadDetailPanel.tsx`)
  — `compact` variant, shown only alongside the "Progress to job"
  button itself; selected ids ride along as `standard_item_ids` in the
  `POST /api/leads/[id]/create-project` body (see that route's section
  above).

Both POST routes copy each selected id onto the new project's spec
register via the **same shared helper**,
`lib/library-items.ts`'s `copyLibraryItemToProject()` /
`copyStandardItems()` — extracted from the exact insert shape `POST
/api/projects/[id]/items` already builds when its body carries a
single `library_item_id` (that route itself is untouched; the shared
helper is a new call site for a SECOND use of the same logic, not a
fork of it). `item_code` is left to the existing DB trigger
(`assign_item_code()`); usage tracking (`usage_count++` +
`project_library_items` upsert) mirrors the existing single-item route
exactly. Copying is best-effort — a stale/deleted id is silently
skipped, never blocking project creation.

**2. Lead notes.** New `lead_notes` table — a structural mirror of
`item_notes` (`id, lead_id, author_id, author_name, text, created_at`,
cascade on `leads` delete, `team_all` RLS same as every other table in
this schema; admin enforcement happens at the route layer like every
other leads table). Routes: `GET`/`POST /api/leads/[id]/notes` (see
their own sections above) — admin-gated like all leads routes, mirror
`GET`/`POST /api/items/[id]/notes` exactly except newest-first
ordering. UI: `components/leads/LeadNotes.tsx` (feed + composer,
timestamps rendered as `"{author_name} · 7 Jul, 10:42am"`, en-AU date +
12-hour time) replaces the old free-text `leads.notes` textarea inside
`components/leads/LeadDetailPanel.tsx` — that column is **not
editable in the UI any more**, display has migrated into the feed.

**Notes migration handling:** the migration itself folds every lead's
pre-existing non-empty `leads.notes` value into exactly one
`lead_notes` row — `author_name = 'Imported note'`, `author_id =
null`, `text` = the legacy value verbatim, `created_at =
leads.created_at`. Guarded by a `NOT EXISTS` check keyed on `(lead_id,
author_name = 'Imported note')` so re-running the migration (this
schema's standing re-run-safety discipline) never duplicates the
import. `leads.notes` itself is **not dropped** — irreversible schema
changes are avoided; the column simply stops being written to by the
app from this round on.

**MCP:** `add_lead_note` tool (`mcp/src/index.mjs`) — thin fetch to
`POST /api/leads/[id]/notes`, `{ lead_id, text }`. See `docs/ARIA.md`'s
own section on this round for a worked example (logging a call/email
outcome).

**Files touched:** `supabase/migrations/030_standards_lead_notes.sql`
(new), `types/round-d.ts` (new — `LeadNote`, `StandardFlagFields`,
`StandardItemIdsInput`, etc.; `types/index.ts` is protected for this
round), `lib/library-items.ts` (new — shared copy helper),
`app/api/library/route.ts` (`?standard=1` filter),
`app/api/library/[id]/route.ts` (`is_standard` in `EDITABLE`),
`components/library/LibraryBrowser.tsx` (badge + toggle),
`app/api/projects/route.ts` (`standard_item_ids` body field + copy),
`components/projects/ProjectForm.tsx` (checklist),
`components/projects/StandardItemsChecklist.tsx` (new, shared by both
Create Project and the leads panel),
`app/api/leads/[id]/create-project/route.ts` (`standard_item_ids` body
field + copy, only on the fresh-create path),
`components/leads/LeadDetailPanel.tsx` (compact checklist + notes feed
replaces the old textarea), `components/leads/LeadNotes.tsx` (new),
`app/api/leads/[id]/notes/route.ts` (new), `mcp/src/index.mjs`
(`add_lead_note` tool), `docs/API.md`/`docs/ARIA.md`/`README.md` (this
round's documentation).

## Board v3 — Monday parity round (migration 031)

BUILD-SPEC.md "Board v3 — Monday parity". Four parts: the real
13-stage construction template (replacing the old 6-phase code
fallback), sub-items (`board_tasks.parent_task_id`, migration 031),
the new default status vocabulary + booking soft-mapping, and a
visual rebuild of the Grouped list view (now THE board default — see
`components/board/ProjectBoard.tsx`'s own header doc comment; Kanban +
side-by-side stay behind the existing layout toggle, unchanged).

### Migration 031 — `board_tasks.parent_task_id`

`supabase/migrations/031_board_v3.sql` adds ONE column:
`board_tasks.parent_task_id uuid null references board_tasks(id) on
delete cascade`, plus an index (`idx_board_tasks_parent`). Nothing else
changes schema-wise this round — the 13-stage template, the default
status-column seed reorder, the visual rebuild, and the dependency
chips are all application-layer only.

One level of nesting ONLY — enforced in **application code**
(`POST /api/projects/[id]/board`), not a DB trigger/check constraint,
per this schema's established "app layer enforces business invariants,
DB enforces referential integrity" split (same discipline migration
029 used for `board_tasks.visit_id`'s "one active booking" rule). A
request whose `parent_task_id` points at a task that ITSELF already
has a non-null `parent_task_id` is rejected with **HTTP 400**
("Cannot create a sub-item of a sub-item — only one level of nesting
is supported").

`ON DELETE CASCADE` is a hard-delete safety net only — this app never
hard-deletes `board_tasks` rows in normal operation (everything is
soft-deleted via `deleted_at`). `DELETE /api/board-tasks/[id]` was
updated this round to ALSO soft-delete any of the task's own sub-items
in the same request, so a deleted parent never leaves invisible
orphaned sub-item rows behind.

### 13-stage template (default `phase_template` + `phase_task_templates` code fallback)

`lib/phase-template.ts`'s `FALLBACK_PHASE_TEMPLATE` now holds the real
13-stage construction sequence (Stage 1 – Site Establishment through
Stage 13 – Handover & Close Out), replacing the prior 6-phase list
(Site Setup umbrella / Demolition / Rough-in / Waterproofing & Tiling /
Fit-off / Handover). **None of the 13 rows are `kind: 'umbrella'`** —
every umbrella consumer in this codebase (`GanttChart.tsx`'s
`phases.find(p => p.kind === 'umbrella') ?? null`, the phases route,
etc.) already treats "no umbrella phase" as a valid, null-safe state,
so a project seeded from this template simply shows no umbrella band
on the Timeline.

A new sibling constant, `FALLBACK_PHASE_TASK_TEMPLATES`, is the
code-level fallback for `app_settings('phase_task_templates')` — the
full 13-stage checklist (every stage's task list, milestone rows
included) ships as this constant rather than a migration-time seed row
(same "code fallback, not a migration seed" mechanism
`lib/design-task-templates.ts`'s `FALLBACK_DESIGN_TASK_TEMPLATES`
already established for its own key). Every milestone row's title
follows the literal `"Stage complete – {outcome}"` wording from
BUILD-SPEC.md, EXCEPT Stage 13's final row ("Project archived"),
which is a plain `kind: 'task'` row — Stage 13 is the last stage and
has no next stage to hand off to.

Both `GET /api/settings/phase-template` and
`GET /api/settings/phase-task-templates` (plus the Settings page's own
server-side reads) now fall back to these two constants instead of the
old 6-phase list / an empty `{}` object, whenever their respective
`app_settings` row is missing. **Existing `app_settings` override rows
already saved in a live database are completely untouched** — this is
a code-level fallback only, consulted solely when no row exists yet.

### "Apply stage template" banner + backfill endpoint

Mirrors `DesignTab.tsx`'s "Apply templates" banner interaction pattern
exactly. Shown on the Board's Grouped list view whenever
`groups.length > 0 && allTasks.length === 0` — i.e. stage groups
already exist (the shared phase-template seed has run) but the WHOLE
BOARD has zero tasks across EVERY group. **"Sparse" is defined at the
WHOLE-BOARD level, not per-group** — a board where one stage has cards
but the other twelve are empty does NOT show this banner (that's
normal steady-state usage).

`POST /api/projects/[id]/board/apply-stage-template`
(`app/api/projects/[id]/board/apply-stage-template/route.ts`, thinly
wrapping `lib/phase-seed.ts`'s `applyStageTemplateToEmptyGroups()`):
walks every existing `board_groups` row for the project and fills ONLY
the groups that currently have **zero non-deleted, TOP-LEVEL**
(`parent_task_id is null`) `board_tasks` — a group that already has at
least one top-level task is left completely untouched. **Idempotency
rule: PER GROUP, not per board** — calling this endpoint twice in a
row, or after someone has since manually added a card to one group but
not others, never duplicates a single task; it only ever tops up
whichever groups are still genuinely empty at the moment it runs.
Response: `{ filled_group_ids, skipped_group_ids, created_count }`.

### Sub-items — API shape (flat, not nested)

**Model choice: FLAT.** `GET /api/projects/[id]/board` continues to
return every non-deleted `board_tasks` row (sub-items included) as a
single flat list per column/group — each row now additionally carries
`parent_task_id` (`BoardTaskV3`, `types/board-v3.ts`). The client
(`components/board/ProjectBoard.tsx`'s `GroupRows`) does the
parent/child grouping itself, by filtering the flat list on
`parent_task_id`, rather than the API embedding a `children[]` array
on each parent row.

**Why:** least disruption to the EXISTING GET response shape (this
round's own explicit tie-breaker) — every existing consumer of the
flat `tasks: BoardTaskCockpit[]` shape (drag-and-drop sort-ladder math,
`GroupRows`/`UngroupedTable`/`StackedColumnSection`) already assumes a
flat array of siblings it can sort/splice/filter by `sort`. A nested
shape would require every one of those call sites to be taught to
recurse, including the sort-ladder reorder math, which deliberately
must NEVER apply across parent/child boundaries anyway. Keeping the
wire shape flat and doing the grouping in ONE place client-side is a
strictly smaller, additive change.

`POST /api/projects/[id]/board` accepts an optional `parent_task_id`
in its body (`CreateBoardTaskInputV3`/`CreateSubTaskInputV3`,
`types/board-v3.ts`):
- The referenced parent must belong to the same project (400 if not).
- The referenced parent must ITSELF have `parent_task_id = null` — a
  depth-2 attempt is rejected with **HTTP 400**
  ("Cannot create a sub-item of a sub-item…").
- When `phase_group_id` is OMITTED alongside `parent_task_id`, the
  sub-item **inherits the parent's `phase_group_id` automatically**
  ("Sub-items inherit phase_group from parent"). Passing
  `phase_group_id` explicitly (including `null`) still overrides that
  inheritance.
- A sub-item's `sort` scope is its own sibling set (every other task
  sharing the same `parent_task_id`) — NEVER the whole column. Both
  `onDropInGroup` and `moveTaskWithinGroup`
  (`components/board/ProjectBoard.tsx`) branch on `task.parent_task_id`
  so drag-reorder and the "Move up/down" buttons can never cross a
  sub-item's reorder into its parent's top-level row order or into a
  different parent's sub-items.

`DELETE /api/board-tasks/[id]` additionally soft-deletes any sub-items
of the deleted task in the same request (best-effort — a failure here
is reported as a non-fatal `warning`, never a 500, since the parent's
own delete already succeeded).

Row-level UI: "Add sub-item" lives in a top-level row's own expanded
editor (`GroupRows`' `renderRow`, click the row to expand). Sub-rows
render indented under their parent with a literal `"└"` prefix glyph,
plus a "done/total" (e.g. "2/3") count chip on the parent row — **a
pure display summary of children only**. Per BUILD-SPEC.md's explicit
deviation note: **there is NO auto-rollup of sub-item completion into
the parent's own status** — a parent's `column_id` (status) only ever
changes via that parent's OWN status pill, never derived from its
children. Sub-items are collapsible per-parent (chevron on the parent
row) and are EXCLUDED from a group's top-level "N items · M done"
summary line (`lib/board-constants.ts`'s `groupSummaryLine()`) — only
parent-level/top-level tasks count toward that.

"My Work" (`GET /api/my-work`, source #1) already includes sub-items
the same way it includes regular tasks — that source queries
`board_task_assignees` by `profile_id` and then selects the matching
`board_tasks` rows directly by id, with no `parent_task_id is null`
filter anywhere in the query. A sub-item assigned to a team member
therefore already surfaces in their My Work feed exactly like any
other assigned card — **no code change was needed** for this
requirement; it was already structurally inclusive.

### Status vocabulary — new default columns + colours

New boards (a project whose Board has never been opened before — zero
existing `board_columns` rows) now seed **Not Booked / Booked / In
Progress / Done**, in that exact order, replacing the prior Board v2
default (Waiting / To Do / In Progress / Done). This affects exactly
two call sites, both already gated on "zero existing columns for this
project": `GET /api/projects/[id]/board` and
`app/(dashboard)/projects/[id]/board/page.tsx`'s own server-side seed.
**Existing (already-seeded) boards are NEVER touched or migrated** —
they keep whatever columns they already have, fully renamable exactly
as before. The new default list lives at
`lib/board-constants.ts`'s `DEFAULT_STATUS_COLUMNS_V3`.

Colour constants (`lib/board-constants.ts`'s `STATUS_PILL_TINTS`,
looked up via `statusPillTintForColumnName()`/`resolveStatusPillTint()`
— case-insensitive, trimmed match on the column NAME, same heuristic
`lib/board-cockpit.ts`'s `DONE_COLUMN_NAMES` already established, since
column sets are per-project/fully editable):

| Column        | Background wash | Text      | Border    |
|---------------|------------------|-----------|-----------|
| Not Booked    | `#F5DCD3`        | `#7A2F16` | `#993C1D` |
| Booked        | `#EDE3D6`        | `#5C4A32` | `#8a6e4b` |
| In Progress   | `#DDE3E8`        | `#3A4750` | `#7C93A3` |
| Done          | `#DCE7DD`        | `#2E4531` | `#4c6b4f` |

Each pill uses a light background wash + a darker foreground text of
the same hue family (same "darker text on light tint" pattern this
codebase's existing coloured surfaces use, e.g.
`components/estimate/VersionCompare.tsx`'s added/removed/changed row
tints) — verified comfortably readable (all four pairs are well above
the WCAG AA 4.5:1 threshold for normal-size text). Sharp corners
throughout — no `border-radius` is ever added (this app's
`tailwind.config.ts` forces `borderRadius` to `0px` globally). A column
whose name doesn't match one of these four exact labels (a renamed
column, or a pre-Board-v3 board still on Waiting/To Do/In
Progress/Done) simply renders the existing neutral/bordered pill style
— never an error, never a fabricated colour.

Stage-group palette (a SEPARATE, unrelated colour concept — the 4px
left edge bar + title text on each Grouped-list stage section, NOT the
status pills above): `lib/board-constants.ts`'s `STAGE_PALETTE`, five
colours cycling by `sort` order — sand `#8a6e4b`, green `#4c6b4f`,
terracotta `#993C1D`, charcoal `#313131`, teal-muted `#3d5a5a`.

### Booking soft-mapping (display-only)

**Rule:** a task whose linked visit's `status === 'confirmed'` renders
its status pill using the **'Booked' column's tint** IF AND ONLY IF
the board has at least one column whose name matches `/booked/i`
(case-insensitive substring match — matches "Booked", "Not Booked",
"Re-booked", etc.). This is checked via
`lib/board-constants.ts`'s `boardHasBookedColumn()` +
`resolveStatusPillTint()`, and applied in
`components/board/ProjectBoard.tsx`'s `GroupRows` (the status pill
cell).

**This is a soft/display-only mapping only.** It never writes
anywhere — the task's real `board_tasks.column_id` (this schema's
actual "status column" FK; there is no literal `status_column_id`
column, migration 013's `column_id` is the field the spec's wording
refers to) is completely unaffected. The pill still shows the task's
TRUE column NAME as its label — only the colour/tint the pill borrows
is overridden when the condition holds. A board with no column
matching `/booked/i` never applies this override, regardless of any
task's visit status.

### Visual rebuild — Grouped list view (now the board default)

Per stage group (`GroupTable`, `components/board/ProjectBoard.tsx`):
full-width table, a 4px coloured left edge bar + coloured stage title
text (the rotating `STAGE_PALETTE`, cycling by `sort` order), column
headers reading **exactly** `ITEM · WHO · STATUS · CONTACT · WORKS ·
DUE · AFTER`, compact ~30px rows (`h-[30px]` row height, `py-1` cells),
a collapse chevron + summary line ("N items · M done" — sub-items
excluded from both counts), and an inline "+ Add item" row at the
bottom of each group. Milestone rows show the ◆ diamond marker plus a
"MILESTONE" chip. Every existing behaviour is preserved: inline
rename, drag reorder, both-dates editing (`GroupPhaseDateInputs`,
untouched), "Book trade"/"Unlink booking" (via the shared
`BoardTaskEditorBody`, untouched), focus ids (`focus-group-<id>`,
`focus-board_task-<id>`, unchanged), phase date inputs + "View on
timeline" link (untouched), tap→move (the Status pill's underlying
`<select>`, unchanged interaction), booking badges (unchanged),
milestones (unchanged ◆ marker, now additionally chipped).

### Stage-complete dependency chips (display-only, no schema, no blocking)

For each stage group (ordered by `sort`), if the PREVIOUS group
contains a milestone task, the FIRST non-milestone task row in the
CURRENT group shows a muted chip reading `"after ◆ {prev milestone
title, trimmed of the literal prefix 'Stage complete – '}"`. Pure
client-side derivation (`lib/board-constants.ts`'s
`computeDependencyChips()`, called once per board render in
`ProjectBoard`'s own `dependencyChipsByGroupId` memo) — **no schema
changes, no actual blocking of task creation or completion**. A full
dependency engine is deliberately out of scope for this round.

### Deliberately out of scope this round (per spec)

- SWMS column (document management stays on `contact_documents`/
  project files).
- Budget/Actual Cost per task (money stays in the Estimate/invoice
  pipeline).
- Formula column (Monday-specific artefact, not needed here).

**Files touched:** `supabase/migrations/031_board_v3.sql` (new —
`board_tasks.parent_task_id`), `lib/phase-template.ts`
(`FALLBACK_PHASE_TEMPLATE` replaced with the 13-stage list;
`FALLBACK_PHASE_TASK_TEMPLATES` added), `lib/phase-seed.ts`
(`seedPhaseTemplateIfEmpty` falls back to the new task-template
constant; `applyStageTemplateToEmptyGroups` added),
`lib/board-constants.ts` (new — `STAGE_PALETTE`,
`DEFAULT_STATUS_COLUMNS_V3`, `STATUS_PILL_TINTS`/
`statusPillTintForColumnName`/`boardHasBookedColumn`/
`resolveStatusPillTint`, `computeDependencyChips`/
`trimMilestoneTitlePrefix`, `groupSummaryLine`, `subItemCountChip`),
`types/board-v3.ts` (new — `BoardTaskV3`, `CreateSubTaskInputV3`,
`BoardColumnV3`/`BoardGroupV3`/`BoardV3Response`,
`ApplyStageTemplateResponse`), `app/api/projects/[id]/board/route.ts`
(GET response retyped to `BoardV3Response`; default column seed
switched to `DEFAULT_STATUS_COLUMNS_V3`; POST accepts
`parent_task_id` + depth guard + phase_group_id inheritance + sub-item
sort scoping), `app/(dashboard)/projects/[id]/board/page.tsx` (same
column-seed switch + V3 response types),
`app/api/projects/[id]/board/apply-stage-template/route.ts` (new),
`app/api/board-tasks/[id]/route.ts` (DELETE cascades a soft-delete to
sub-items), `app/api/settings/phase-task-templates/route.ts` +
`app/(dashboard)/settings/page.tsx` (fallback switched to
`FALLBACK_PHASE_TASK_TEMPLATES`), `components/board/ProjectBoard.tsx`
(GroupTable/GroupRows/UngroupedTable rebuilt; "Apply stage template"
banner; `addSubTask`; dependency-chip memo; sub-item-aware
`onDropInGroup`/`moveTaskWithinGroup`), `docs/API.md`/`README.md`
(this round's documentation).

## Board v3.1 — display-first cells + phase date rollup

Cells (status/dates) render as plain text/pills at rest, becoming
controls only on click — no schema or route changes of their own
(`components/board/StatusPill.tsx`, `components/board/DateCell.tsx`,
`components/board/PopoverCell.tsx`). The one server-side addition:
**phase date rollup** (`lib/phase-rollup.ts`'s
`rollupPhaseDatesForGroup(supabase, phaseGroupId)`) — whenever ANY
non-deleted `board_tasks` row in a `phase_group_id`'s group has a
`booking_date` set, `schedule_phases.start_date`/`end_date` (for that
group's linked phase) are overwritten to `min(booking_date)`/
`max(booking_end_date, falling back to booking_date)` across every
dated task in the group. A group with zero dated tasks is a no-op —
the phase's dates stay whatever they were (manual or untouched).
Called, best-effort (try/catch, log-and-swallow — a rollup failure
never fails the write that triggered it), from every `board_tasks`
write path that can change a task's works-date footprint: `PATCH
/api/board-tasks/[id]` (on a `phase_group_id` change, both the old and
new group are rolled up), `POST`/`DELETE
/api/board-tasks/[id]/book-visit`, `DELETE /api/board-tasks/[id]`.

**"Derived" is the same condition everywhere it's checked** — this
matters for Board v3.2 below, which needs to detect it too:
- Server write: `lib/phase-rollup.ts`'s own `withDates.length === 0`
  no-op check.
- Server read (Timeline tab): `app/(dashboard)/projects/[id]/board/../timeline/page.tsx`
  builds `worksDatesLockedPhaseIds` — any phase whose linked
  `board_groups` row has a `board_tasks` row with `booking_date` set —
  and passes it to `<GanttChart worksDatesLockedPhaseIds={...} />`,
  which disables `PhaseEditPanel`'s Start/End inputs for exactly those
  phase ids ("dates come from items" hint).
- Client read (Board tab): `lib/board-constants.ts`'s
  `computeGroupWorksDateRange(tasks)` — same min/max formula, called
  from `GroupTable`'s header to show the computed range read-only
  instead of the manual `GroupPhaseDateInputs`.

All three independently re-derive "does at least one task in this
group have a `booking_date`" from the same underlying data (no shared
constant/flag is persisted anywhere) — they cannot drift from each
other because they're all trivial one-line min/max-over-dated-tasks
checks, not configurable business logic.

## Board v3.2 — two-way timeline sync + reorder animation

v3.1 made board -> timeline flow one-way (the rollup above). This round
adds the reverse direction — dragging a DERIVED phase's Timeline bar
now writes back to its linked group's tasks — plus a purely
presentational reorder animation on the Board's drag-and-drop.

### POST /api/phases/[id]/shift-items
Auth: session. Body: `{ delta_days: number }` (whole days, positive =
later, negative = earlier — the same day-snapped unit
`lib/phase-drag.ts`'s `snapDeltaDaysFromPxPerDay` already produces for
an ordinary phase drag). Only valid for a **derived** phase (see the
shared detection above) — 404 if the phase doesn't exist, 400 if it has
no linked `board_groups` row or that group has zero tasks with a
`booking_date` set ("dates are not derived").

Shifts every non-deleted task in the linked group: `booking_date` and
`booking_end_date` (or `booking_date` again, when a task has no
distinct end) both move by `delta_days`. Runs as a plain sequential
loop, not a DB transaction (Supabase's JS client has no multi-row
transaction primitive here) — each task's update is independent, so one
bad row's error is collected rather than aborting the rest of the
group's shift. Response: `{ tasks: ShiftedTaskResult[],
reconfirm_task_ids: string[], reconfirm_visit_ids: string[] }` where
`ShiftedTaskResult` is `{ id, booking_date, booking_end_date, ok,
error? }` per task.

**Confirmed-visit re-send affordance:** for every shifted task that
carries a `visit_id` linked to a `trade_visits` row currently `status =
'confirmed'`, that visit's own `start_date`/`end_date` are updated to
match (keeping the denormalised pair in sync, same discipline
`POST`/`DELETE /api/board-tasks/[id]/book-visit` already apply) and
both the task id and the visit id are added to `reconfirm_task_ids`/
`reconfirm_visit_ids` — returned in both forms since API callers may
only hold one or the other (the Board holds task ids; `GanttChart.tsx`
holds visit ids, via each phase's own `visits` array, and keys its
existing "Dates changed — re-send confirmation?" affordance
(`ReconfirmAffordance.tsx`) by visit id). The visit's `status` itself is
**not** reset here — only the explicit `POST
/api/visits/[id]/resend-confirmation` button-press does that; this
route only moves dates and flags the affordance. `rollupPhaseDatesForGroup`
re-runs at the end (best-effort) so `schedule_phases` reflects the
shifted set immediately.

### POST /api/phases/[id]/adjust-boundary
Auth: session. Body: `{ edge: 'start'|'end', new_date: string }`. Same
"derived phase only" gate as shift-items above. A derived phase has no
single row to resize (its range is computed from its tasks) — dragging
an EDGE zone instead moves only the ONE **boundary item** that
currently defines that edge:
- `edge: 'start'` — the task with the EARLIEST `booking_date` has that
  date moved to `new_date` (its own end untouched). 400 if `new_date`
  would land after that same task's own end date.
- `edge: 'end'` — the task with the LATEST effective end
  (`booking_end_date`, falling back to `booking_date`) has that date
  moved to `new_date` (its own start untouched). 400 if `new_date`
  would land before that same task's own start date.

Ties (two tasks sharing the same earliest/latest date) break on lowest
`id` — deterministic, no business meaning. Deliberately does NOT
validate the new date against any OTHER item's range — moving the
first item's start later than the second-earliest item's start is
allowed and simply changes which item is "earliest" on the next rollup
read, same as editing that date directly on the Board. Response: `{
task: { id, booking_date, booking_end_date }, reconfirm_task_ids:
string[], reconfirm_visit_ids: string[] }` — same confirmed-visit
re-send convention as shift-items (at most one id each, since a
boundary adjustment only ever touches one task). Rollup re-runs
afterwards.

### GanttChart.tsx wiring
`commitDrag` (the existing drag-commit function every phase-bar
gesture already funnelled through) now branches on
`worksDatesLockedPhaseIdSet.has(phase.id)` — the SAME set
`PhaseEditPanel` already uses to disable its date inputs (see the
shared-detection note above):
- **Derived + mode `'move'`** (drag the bar BODY) -> `shiftDerivedPhase`
  -> `POST .../shift-items`. Optimistic: the phase's own start/end shift
  immediately by the same delta (revert-on-failure, same shape every
  other optimistic edit in this file uses), then a light re-fetch of
  just this phase (`refreshPhase`, via the existing `GET
  /api/projects/[id]/phases`) reconciles to the server's rollup-fresh
  values.
- **Derived + mode `'resize-start'`/`'resize-end'`** (drag an EDGE
  zone) -> `adjustDerivedBoundary` -> `POST .../adjust-boundary`, then
  the same `refreshPhase` reconcile (no local optimistic guess here —
  this route only touches one item, which this component doesn't hold
  locally).
- **Manual (non-derived) phase** — byte-for-byte the pre-existing path:
  `applyDrag` + `patchPhase` (`PATCH /api/phases/[id]`), completely
  untouched.

Either derived path's response `reconfirm_visit_ids` is merged into
`reconfirmPrompts` (`flagReconfirmForVisits`) — the exact same Set
`ReconfirmAffordance`/`commitVisitDrag` (an ordinary visit sub-bar drag)
already render from, so a phase-body/edge drag surfaces the identical
UI a direct visit drag would.

**Edge-zone tooltips:** for a derived phase only, two thin overlays
exactly matching `handlePointerDown`'s existing `EDGE_ZONE_PX` hit-test
width render `title="Adjusts first item"` / `"Adjusts last item"` — not
`pointer-events-none` (a native tooltip needs the hover target to
actually receive the event) but they don't `stopPropagation`, so the
pointerdown still bubbles to the bar's own handler and the existing
`offsetX`-based mode computation is untouched. A manual phase's edges
keep the plain single tooltip (the date range) unchanged.

### Reorder slot animation (Board — grouped list + sub-items)
`components/board/ProjectBoard.tsx`'s `GroupRows` (used by both
`GroupTable` per stage group and the "Ungrouped" bucket) gained
`dragOverIndex` state — `{ listKey, index } | null`, where `listKey` is
`"top"` for the top-level task list or a parent task's own id for that
parent's sub-item list (mirrors `onDropInGroup`/`moveTaskWithinGroup`'s
existing "same `parent_task_id`" sibling-set rule exactly, so a gap
only ever opens within the correct list). Each row's `onDragOver` sets
`dragOverIndex` to the position a drop would actually land at (same
index `onDropAtIndex` already receives) based on which half of the row
the pointer is over; every row at/after that index in the SAME list
renders `transform: translateY(32px)` (a `REORDER_ROW_PX` constant
matching the row's fixed `h-8`/32px height) with a ~120ms ease-out
transition, and a 2px sand (`bg-sand`) drop-line row renders immediately
before the gap position. On drop, `playSettleAnimation` clears the gap
and flags the dropped row's id for a brief (150ms ease-in) settle
transform, auto-clearing after it plays once. Cleared on `dragend`
(fires on the drag source regardless of outcome) and on the table's own
`onDragLeave` (fallback for a drag that leaves the table without
dropping).

**This is presentation only** — `dragTaskId`, `onDragStartTask`,
`onDropAtIndex`/`onDropInGroup`, and the sort-ladder math are all
byte-for-byte unchanged. **Hit-testing correction:** a CSS `transform`
does NOT move a row's siblings (no layout/reflow triggered — this is
exactly why the animation is safe to build on transforms in the first
place), but it DOES change what `getBoundingClientRect()` reports for
the TRANSFORMED element itself. Since a row already shifted by a
previous dragover tick (`gapTransform` returning a non-empty
`translateY` for it) can itself be the row the pointer is now over,
`onDragOver`'s hit-test explicitly recomputes that row's untransformed
top (`rect.top - REORDER_ROW_PX` whenever `gapTransform` is currently
non-empty for it) before comparing against the cursor's Y position —
without this correction the gap/drop-line would drift out of sync with
the cursor as a drag crosses an already-open gap. `onDropAtIndex`
itself never reads any bounding box at all (it only ever receives the
plain integer index computed this way), so the actual persisted drop
position is unaffected either way — this correction only fixes the
drop-line indicator's visual tracking, not the drop's correctness.

**Kanban stacked sections** (`StackedColumnSection`) do NOT get this
animation — that view has no per-row drop-index target at all (a drop
anywhere in a section appends at the end; see that function's own doc
comment), so there is no real drop position for a gap to represent. Not
"trivially shareable" per this round's own spec wording.

**Files touched:** `types/board-v3-2.ts` (new — `ShiftItemsInput`/
`ShiftItemsResponse`/`ShiftedTaskResult`, `AdjustBoundaryInput`/
`AdjustBoundaryResponse`), `app/api/phases/[id]/shift-items/route.ts`
(new), `app/api/phases/[id]/adjust-boundary/route.ts` (new),
`components/gantt/GanttChart.tsx` (`commitDrag` branches on
derived-phase detection; `shiftDerivedPhase`/`adjustDerivedBoundary`/
`refreshPhase`/`flagReconfirmForVisits` added; edge-zone tooltip
overlays on both the windowed and Month-zoom bar variants),
`components/board/ProjectBoard.tsx` (`GroupRows` gains
`dragOverIndex`/`settlingId` state + `gapTransform`/
`playSettleAnimation`/`clearDragOver`; `renderRow`'s `<tr>` gains the
transform/transition classes, drop-line rows, and `onDragOver`/
`onDragEnd` wiring; `REORDER_ROW_PX`/`REORDER_GAP_MS` constants added;
doc-comment note on why `StackedColumnSection` is excluded),
`docs/API.md`/`README.md` (this round's documentation). No migration —
this round writes only to existing `board_tasks`/`trade_visits`/
`schedule_phases` columns.

## Board v3.3 — placeholder dates + booking actually sends

Corrects a workflow-breaking deviation (v3.1 made works dates read-only)
and closes the booking loop (a booked visit used to sit silent until the
day-before cron). Three parts, no migration — every column touched
already exists (`board_tasks.booking_date`/`booking_end_date`,
`trade_visits.start_date`/`end_date`/`reminder_sent_at`).

### 1. Works dates rejoin the PATCH whitelist (reverses v3.1)

`PATCH /api/board-tasks/[id]`'s `EDITABLE_FIELDS` gains `booking_date`/
`booking_end_date` back. **Whitelist/comment reconciliation:** the
route's own comment previously said these two columns were "only ever
written via POST/DELETE .../book-visit" (a true statement through
v3.1/v3.2). That comment has been REPLACED in place (not merely
appended to) with the full "reverses v3.1" story — migration 029's own
SQL column comments on `board_tasks.booking_date`/`booking_end_date`
still say the old thing (no migration this round, so that SQL-level text
is now stale relative to the route) — `types/board-cockpit.ts`'s
`PatchBoardTaskCockpitInput` doc comment (a prior round's own file) was
also updated in place, one line, to point at the new behaviour rather
than left contradicting it.

Validation: end >= start whenever the RESULTING row (post-merge with
whatever the caller didn't touch this request) would have both dates
set — not just the two keys literally present in the body. **Visit
sync:** when the task carries a `visit_id`, the new dates are pushed
onto the linked `trade_visits` row in the same request (mirrors
`shift-items`/`adjust-boundary`'s identical sync block); if that visit
was `status = 'confirmed'`, its id comes back in the response's
`reconfirm_visit_ids` so the client can surface the shared "Dates
changed — re-send confirmation?" affordance
(`components/gantt/ReconfirmAffordance.tsx`, now also imported into
`ProjectBoard.tsx` — not duplicated). A task with no `visit_id` is a
pure placeholder; its dates just write to `board_tasks`.

**Rollup confirmed still fires:** `rollupPhaseDatesForGroup` already ran
on a `phase_group_id` change (v3.1); it now ALSO runs whenever this
request touched `booking_date`/`booking_end_date` directly (previously
only book-visit's own POST/DELETE could trigger it for those columns —
verified this was the one gap, since v3.1 never anticipated a direct
booking-date PATCH existing at all).

`components/board/DateCell.tsx`'s `WorksDateCell` is rebuilt as a
genuine start+end popover (two `<input type="date">`s, autofocus on
Start), committing BOTH dates as one `{ booking_date, booking_end_date }`
PATCH (never two separate requests, so the server's start<=end
validation never sees a transient invalid pair); Esc cancels; shows
"Also updates the booked visit" inside the popover whenever `visitId` is
set. `ProjectBoard.tsx`'s `GroupRows` row wires this cell's `onCommit`
straight to `onPatchTask` — "Book trade" no longer lives on this cell at
all; it remains reachable only via its own explicit buttons
(`BoardTaskEditorBody`'s Book trade/Unlink actions, the kanban card, the
grouped-list row's expanded editor). New types:
`types/board-v3-3.ts`'s `PatchBoardTaskV33Input` (intersection over
Phase 12a-B's `PatchBoardTaskInputV2`, per this codebase's per-round-
own-file convention — neither prior file is edited) and
`PatchBoardTaskV33Response`.

### 2. Booking sends the request immediately

`POST /api/board-tasks/[id]/book-visit` now composes and sends the
trade's confirmation email the moment a visit is booked (or an existing
one is linked) — reuses `POST /api/visits/[id]/resend-confirmation`'s
own template shape (itself copied from `trade-reminders`' template, per
that route's own "STATE-MACHINE FINDING" doc comment — there was no
literal "the send used at creation" to reuse, since visit CREATION had
never sent anything before this round; the nearest existing tone/subject
shape is what's reused, subject prefixed "RESLU · site booking" per
BUILD-SPEC's own wording). New helper `sendBookingConfirmationEmail`
(same file) — called for BOTH the "create a new visit" and "link an
existing visit" branches (a linked visit may equally never have had a
send of its own).

**Cron interaction:** `reminder_sent_at` is deliberately left `null` by
this route — `GET /api/trade-reminders`'s day-before cron is completely
unchanged and still fires 1-2 days before `start_date`, gated by its own
existing `reminder_sent_at IS NULL` filter. This means a visit booked
far in advance gets TWO touches (this immediate email, then the
day-before reminder) — accepted and documented per BUILD-SPEC's own
item 2 wording ("yes, keep day-before reminder as a second touch").
**Documented edge case:** a visit booked TODAY for tomorrow/the day
after falls inside the cron's 1-2-day window too and would get the
reminder on its very next run — same day as the immediate send. Accepted
as harmless (a trade hearing about a 24-48-hour-notice booking twice in
one day is not worth extra gating logic).

**No duplicate emails within one booking flow:** the immediate send
happens exactly once, inside the POST handler, after the task/visit
write already committed — nothing else in the request path calls
`sendTeamEmail` a second time, and the day-before cron is a wholly
separate scheduled invocation (never triggered synchronously by this
route), so a single booking action can never itself cause two sends.

Response gains `email_sent` (boolean) and `email_skip_reason` (one of
`no_gmail_config` / `no_contact` / `no_contact_email`, present only when
`email_sent` is false). `BookVisitPanel.tsx` shows "Request sent to
{contact}" vs. "Email not sent: {reason}" inline on success;
`ProjectBoard.tsx` also flashes a short-lived board-level echo
(`bookingEmailNotice` state) near the existing error banner, since
`email_sent`/`email_skip_reason` are one-time outcomes with nowhere
persisted to read them from on a later page load (no new migration this
round). New types: `types/board-v3-3.ts`'s `BookVisitEmailSkipReason`,
`BookVisitV33Response`.

### 3. Prefill trace + fix

Traced every `BookVisitPanel` opener (`BoardCard`'s kanban card,
`StackedColumnSection`'s rows via `BoardTaskEditorBody`,
`GroupTable`/`GroupRows`, `UngroupedTable`) — all four already pass the
full `BoardTaskV3` through to `ProjectBoard`'s `bookingTask` state and
on into `initialPhaseId`/`initialContactId`/`initialStartDate`/
`initialEndDate`, exactly as the prior "Two more" round's own prefill
fix intended. **No opener currently drops the context** — that fix
holds. What was still missing: the panel gave no VISIBLE signal that it
HAD arrived with card context, so a genuinely-blank field (an unphased
card, a trade-less card) was indistinguishable from a dropped-context
bug at a glance — the likely reading of the 00:21 screenshot report.
Fixed with a "From: {title}" trace line (`cardContext` prop, new
`BookVisitPanelCardContext` type) shown whenever the panel has card
context, plus a phase-select lock (a quiet read-only chip with its own
"Change" link, swapping to the ordinary `<select>` on click) whenever a
card supplied a resolved initial phase — judged the safer default since
a phase MISMATCH was the specific failure mode reported, while the trade
picker stays a normal, always-editable control (not locked) since
contact_id isn't the field the report was about.

**Files touched:** `app/api/board-tasks/[id]/route.ts` (EDITABLE_FIELDS,
PATCH validation/sync/rollup, doc comments), `app/api/board-tasks/[id]/book-visit/route.ts`
(`sendBookingConfirmationEmail`, response fields, doc comments),
`components/board/DateCell.tsx` (`WorksDateCell` rebuilt,
`formatWorksDateRange` extracted/exported), `components/board/BookVisitPanel.tsx`
(`cardContext` prop, phase lock, email outcome display),
`components/board/ProjectBoard.tsx` (`WorksDateCell`'s call site,
`reconfirmPrompts`/`resendConfirmation`/`dismissReconfirm` state +
threading through `GroupTable`/`UngroupedTable`/`GroupRows`,
`bookingEmailNotice` state + banner, `bookVisit`'s return shape),
`types/board-v3-3.ts` (new), `types/board-cockpit.ts` (one doc-comment
line corrected in place), `docs/API.md`/`README.md` (this round's
documentation). No migration.

## Trade booking document pack (8 July 2026)

BUILD-SPEC.md "Trade booking document pack": staff can attach a
project's Plans, a filtered FF&E schedule, and the latest issued Scope
of Works to a trade's own booking page, chosen once at booking time in
`BookVisitPanel`'s new "Include documents" section.

**Migration `032_visit_document_pack.sql`** adds
`trade_visits.document_pack jsonb` (nullable, no RLS change). See the
"Schema reference" entry under the Phase 11A trade-confirmation-engine
section above for the full column shape, and this migration's own
comment for the three-state `schedule_categories` encoding (key absent
= Schedule unticked; `null` = full schedule; `string[]` = filtered).

**Resolution semantics — read before touching any of this round's
code:** `document_pack` stores CHOICES frozen at booking time, never
which file/revision satisfies them. Every render/request re-resolves
the CURRENT latest matching document (`lib/trade-doc-pack.ts`'s
`latestPlansFile`/`latestIssuedSow`) against `project_files`/
`sow_documents` at that moment — a plan revised after booking is what
the trade sees next load, with no re-booking; a document later deleted
with nothing newer just drops its row rather than showing a broken
link. The CHOICE itself (whether each doc type is offered at all, and
which schedule categories) stays exactly as picked at booking time —
there is no "edit an existing visit's pack" affordance in this round
(BUILD-SPEC's item 1 only asks for storage, not a later-edit UI).

**Export presets gain `contact_categories`** (see the
`GET`/`PUT /api/settings/export-presets` entries above) — an optional
free-text field per preset used only by the Schedule auto-pick below;
no schema change (`app_settings` already carried presets with no
migration).

### BookVisitPanel "Include documents" section

Three checkboxes, each defaulting ON exactly once per panel open when
its corresponding document is available (a `defaultsApplied`-guarded
effect — never re-fights a staff member's own subsequent untick):

- **Plans** — ON if any `project_files` row with `kind='plans'` exists
  for the project; shows the latest revision label
  (`lib/trade-doc-pack.ts`'s `latestPlansFile`, same newest-first sort
  `ProjectDocuments.tsx` uses).
- **Schedule** — always defaults ON when this section renders at all.
  Auto-picks a category subset via
  `lib/export-presets.ts`'s `pickPresetForContactCategory()`: (1)
  case-insensitive containment match of the selected contact's
  `category` against any preset's `contact_categories`, tried in both
  directions; (2) failing that, a small built-in keyword table (plumb,
  electric, tiler, carpen, paint, plaster, cabinet, waterproof,
  concret, brick, roof, glaz, landscap, hvac, airconditio) matched
  against both the contact's category and each preset's own NAME; (3)
  failing both, falls back to the full schedule (no category filter).
  The picked preset's name (or "Full schedule"/"Custom") is shown with
  a "Change" link that reveals a plain `<select>` over every configured
  preset plus "Full schedule".
- **Scope of Works** — ON if any `sow_documents` row with
  `status='issued'` exists; shows that revision's label
  (`lib/trade-doc-pack.ts`'s `latestIssuedSow`).

On submit, the three choices are frozen into
`{include_plans, schedule_categories?, include_sow}` (the schedule key
present only when Schedule is ticked — see the migration's own
three-state note) and sent as `document_pack` on the existing
`onBook()` call, which `ProjectBoard.tsx`'s `bookVisit()` forwards
verbatim in its `POST /api/board-tasks/[id]/book-visit` body. The whole
field is omitted (not an all-false object) when nothing is ticked.

### POST /api/board-tasks/[id]/book-visit — `document_pack` addition

Body gains an optional `document_pack` (see above). Written onto the
SAME insert/update as the rest of the booking — never a second write —
on BOTH branches (a brand-new visit, or `existing_visit_id`). On the
link-an-existing-visit branch, an OMITTED `document_pack` in the
request body leaves that visit's existing pack (if any, from an
earlier booking) completely untouched — only an explicitly-supplied
pack ever overwrites one. The confirmation email (see Board v3.3 item 2
above) now also mentions the pack (see below) whenever the EFFECTIVE
pack — the one just supplied, or the visit's pre-existing one when none
was supplied — has anything ticked.

### Trade page DOCUMENTS section

`app/trade/[token]/page.tsx` renders a `components/trade/
TradeDocuments.tsx` section whenever the visit's `document_pack` is
non-null, resolved server-side (service-role client, same trust
boundary as the rest of the page) on every load:

- **Plans row** — latest `project_files` `kind='plans'` row, labelled
  with its revision (or bare "Plans" if unlabelled); a best-effort
  Storage `list()` call adds a human file-size label
  (`lib/trade-doc-pack.ts`'s `formatFileSize`) when cheap to determine.
  Omitted entirely if every plans revision has since been deleted.
- **Schedule row** — always present when the pack's `schedule_categories`
  key exists at all, labelled "Your schedule — {preset name|Custom|Full
  schedule}" via `findPresetNameForCategories()` (an exact prefix-set
  match against the studio's CURRENT presets — a preset renamed/deleted
  since booking collapses to "Custom", same as a hand-edited selection).
- **SOW row** — latest ISSUED `sow_documents` revision, labelled with
  its revision. Omitted if none has ever been issued (or the only
  issued one was since soft-deleted).

Each row's `href` points at one of the three new tokened proxy
endpoints below; no signed URL or byte stream is embedded directly in
the page's own HTML.

### GET /api/trade/[token]/documents/plans / .../schedule / .../sow

Documented in full under the Phase 11A "Trade confirmation engine"
section above (search "Trade booking document pack round" there) —
summary: token-gated identically to `respond` (rate-limited, token
resolves to a real non-deleted non-expired visit, AND the visit's
`document_pack` must have the specific choice ticked or the route 404s
regardless of the visit's own validity — the "only pack-selected docs
reachable" guarantee this round's own verification pass targeted).
Plans redirects to a fresh 1-hour signed URL; Schedule streams the
byte-for-byte-verified-pricing-free spec PDF (reusing
`GET /api/projects/[id]/pdf`'s own cache); SOW streams the branded SOW
PDF uncached (matching the team-facing SOW route's own behaviour).

### Email copy — item 4

Three send sites gain one shared, optional line
(`lib/trade-doc-pack.ts`'s `documentPackMentionLine()` — "Plans, your
schedule and the scope of works are on your booking page."), appended
only when `hasAnyDocumentPackChoice()` is true for the relevant visit's
(effective) pack:

- **`POST /api/board-tasks/[id]/book-visit`**'s immediate booking email
  (`sendBookingConfirmationEmail`, this round's `hasDocumentPack` param).
- **`POST /api/visits/[id]/resend-confirmation`**.
- **`GET /api/trade-reminders`**'s day-before reminder (visit read via
  that route's own existing `select("*")`, cast narrowly since
  `lib/trade-visits.ts`'s `TradeVisit` type — untouched this round —
  doesn't declare `document_pack`).

The wording never varies by which of the three choices is actually
ticked — a trade opening their booking page sees precisely which rows
are present in the DOCUMENTS section itself; the email line is a
heads-up, not a literal inventory.

**Files touched:** `supabase/migrations/032_visit_document_pack.sql`
(new), `types/trade-doc-pack.ts` (new), `lib/trade-doc-pack.ts` (new —
`latestPlansFile`, `latestIssuedSow`, `scheduleLabel`,
`findPresetNameForCategories`, `formatFileSize`,
`hasAnyDocumentPackChoice`, `documentPackMentionLine`),
`types/round-export-batch.ts` (`ExportPresetRow.contact_categories`,
in place), `lib/export-presets.ts` (`cleanPresetRow` extended,
`pickPresetForContactCategory` + heuristic helpers, new),
`components/settings/ExportPresetSettings.tsx` ("Applies to contact
categories" field), `components/board/BookVisitPanel.tsx` ("Include
documents" section, availability-aware defaults, Schedule auto-pick +
change-select), `components/board/ProjectBoard.tsx` (`bookVisit`'s
input type only), `app/api/board-tasks/[id]/book-visit/route.ts`
(`document_pack` body field, `sendBookingConfirmationEmail`'s
`hasDocumentPack` param), `app/api/visits/[id]/resend-confirmation/route.ts`
(mention line), `app/api/trade-reminders/route.ts` (mention line),
`app/trade/[token]/page.tsx` (DOCUMENTS section resolution + render,
corrected stale middleware doc-comment), `components/trade/
TradeDocuments.tsx` (new), `app/api/trade/[token]/documents/plans/route.ts`
(new), `app/api/trade/[token]/documents/schedule/route.ts` (new),
`app/api/trade/[token]/documents/sow/route.ts` (new), `docs/API.md` /
`README.md` (this round's documentation). Single migration (032); no
protected file touched (verified `lib/supabase/middleware.ts`,
`vercel.json`, and the rest of the protected list by mtime — all
pre-date this round's work).

## Order-by engine — product deadlines from trade bookings (8 July 2026)

BUILD-SPEC.md "Order-by engine": an item a trade installs must be
ordered [lead time] before that trade's works date — e.g. a sliding
door frame (DR), Carpenter booked 21 Jul, 3-week lead time = order by
30 Jun. **No new migration.** Everything is computed on read from
existing schema (`items.lead_time_weeks`/`ordered_at`, `trade_visits`,
`board_tasks.booking_date`, `contacts.category`, and the existing
export-presets `app_settings` row).

**The mapping is the existing export presets, reframed.** Presets
already carry `prefixes[]` (item category prefixes) and
`contact_categories[]` (trade contact categories) — this one row IS the
category↔trade↔contact mapping the engine needs; no new mapping table.
In Settings, this list is now labelled **"Trade mappings"** (copy only
— see `components/settings/ExportPresetSettings.tsx`'s and
`app/(dashboard)/settings/page.tsx`'s header comments; the component
name, props, and `app_settings('export_presets')` shape are unchanged)
since it now backs both the schedule PDF export dialog AND this engine.

**`lib/order-by.ts`** (new, pure, no I/O) is the single derivation used
by every surface below:

- `deriveOrderBy(items, presets, contacts, sources, now?)` — for each
  UNORDERED item (`ordered_at` is null): finds every preset whose
  `prefixes[]` includes the item's `category`, finds every works-date
  source (`WorksDateSource` — a trade visit or a board-task booking
  placeholder, caller-normalised) in the SAME project whose linked
  contact matches one of those presets (via
  `lib/export-presets.ts`'s `pickPresetForContactCategory()`, reused
  verbatim — never reimplemented), and takes the EARLIEST such date.
  `order_by = works_date − (lead_time_weeks × 7 days)`. Status:
  `'overdue'` (order_by has passed), `'due_soon'` (order_by ≤ 7 days
  out), `'ok'` (further out), `'no_lead_time'` (a works date was found
  but the item has no lead time — "set lead time", never guessed),
  `'no_booking'` (no relevant works date at all, regardless of lead
  time).
- `missingLeadTimes(items)` — a SEPARATE, additive check: every
  unordered item with no `lead_time_weeks`, regardless of whether any
  booking exists. (Phillip, 8 Jul: "lead-time hygiene happens at
  quoting time, not in a panic at booking time.")
- Date math is date-only (`Date.UTC` day boundaries), matching
  `lib/board-cockpit.ts`'s `isDateOnlyPast()` convention — no
  time-of-day/timezone drift.

### GET /api/projects/[id]/order-by

Admin-only (403 for non-admins, before any query runs — same gating as
`GET /api/projects/[id]/estimate`; order_by is derived from
`lead_time_weeks`, a Pricing & Procurement-only field). Returns
`{ rows: OrderByRow[], missing_lead_time_item_ids: string[] }` — one row
per unordered item in the project (status/order_by/works_date/matched
preset name/matched contact), plus the project-scoped missing-lead-time
id list. Consumed by `ProcurementView.tsx`'s new **ORDER BY** column,
lazy-fetched by `ProjectWorkspace.tsx` the first time an admin opens the
Procurement view (identical trigger condition to the existing
measurement-link fetch).

### GET /api/projects/[id]/attention

New, additive, project-scoped route (this codebase's existing
attention feeds — `GET /api/visits/attention`,
`GET /api/board-tasks/attention`, `GET /api/contacts/attention`,
`GET /api/leads/attention`, `GET /api/materials/attention` — are each
their own per-domain, cross-project endpoint; none of them or their
response shapes are touched by this round). Admin-only, same gating as
`GET /api/projects/[id]/order-by`. Returns:

```json
{
  "ordering_due": [
    { "item_id": "...", "item_code": "DR-03", "item_name": "Sliding door frame",
      "status": "overdue", "order_by": "2026-06-30", "works_date": "2026-07-21",
      "matched_preset_name": "Carpenter" }
  ],
  "missing_lead_times": { "count": 4, "href": "/projects/{id}?tab=ffe&focus=ordering_due-{itemId}" }
}
```

`ordering_due` includes only `due_soon`/`overdue` items, sorted
overdue-first then by `order_by` ascending. `missing_lead_times` is a
count + P&P deep link built from `lib/order-by.ts`'s
`missingLeadTimes()`.

### ProcurementView — ORDER BY column

New column between Delivered and Status. Chip rendering: red-outlined
date if overdue, sand-outlined date if due_soon, plain date if ok, sand
"Set lead time" label if a works date was found but no lead time is
set, `—` if no relevant booking exists. A small sand dot renders next
to the chip on ANY row missing `lead_time_weeks` (suppressed only when
the main chip already says "Set lead time", to avoid the same signal
twice on one row) — this is the row-independent "missing lead time"
marker, driven by `missing_lead_time_item_ids`, not by whether a
booking was ever found. Each row also carries a
`focus-ordering_due-{itemId}` anchor (alongside its pre-existing
`focus-decision_overdue-{itemId}` id) for My Work / attention-feed deep
links (`FocusOnLoad.tsx`).

### My Work — "ordering_due" rollup line

`GET /api/my-work` gains an admin-only ninth source (same
`if (isAdmin) { ... }` gating as the existing lead-follow-ups source):
one line per (project, matched trade/preset) pair with at least one
`due_soon`/`overdue` item, formatted `"Order N items for {trade name} —
works {DD/MM}"`, `due` = the group's earliest `order_by` date, `href` =
`/projects/{id}?tab=ffe&focus=ordering_due-{itemId}` — the SAME
`?tab=`/`?focus=` deep-link convention every other My Work line already
uses (see the existing `decision_overdue` source for precedent). The
FF&E tab's `?focus=` handling (`app/(dashboard)/projects/[id]/page.tsx`)
now also opens straight into the Procurement sub-view for
`ordering_due-` focus ids, mirroring its existing `decision_overdue-`
branch.

### MCP / Aria

- **`update_item_pricing`** gains an optional `lead_time_weeks` number
  arg — Aria records it whenever a supplier's quote states one, closing
  the lead-time-hygiene gap at quoting time rather than only via the
  P&P UI. The items PATCH route's field whitelist already included
  `lead_time_weeks` (added in an earlier round) — no change needed
  there.
- **`get_ordering_attention`** (new tool, `project_id` required) — thin
  fetch to `GET /api/projects/[id]/attention`. Per-project (unlike
  `get_bookings_overdue`/`get_needs_attention`, which are cross-project)
  since order-by derivation is inherently project-scoped; Aria calls
  `list_projects` then this tool per project of interest to build a
  cross-studio chase list.
- **`get_needs_attention`**'s description now explicitly notes it is
  LEADS-only and points Aria at `get_bookings_overdue`/
  `get_ordering_attention` for booking/ordering chases instead (its own
  four lead groups are unchanged).

**Files touched:** `lib/order-by.ts` (new), `types/order-by.ts` (new),
`app/api/projects/[id]/order-by/route.ts` (new),
`app/api/projects/[id]/attention/route.ts` (new),
`components/items/ProcurementView.tsx` (ORDER BY column — this file is
explicitly NOT protected this round),
`components/items/ProjectWorkspace.tsx` (lazy order-by fetch, prop
wiring), `app/(dashboard)/projects/[id]/page.tsx` (`ordering_due-` focus
branch), `app/api/my-work/route.ts` + `types/phase-12a-b.ts`
(`ordering_due` source + kind), `mcp/src/index.mjs`
(`update_item_pricing` extension, `get_ordering_attention` new tool,
`get_needs_attention` description update),
`components/settings/ExportPresetSettings.tsx` +
`app/(dashboard)/settings/page.tsx` ("Trade mappings" copy only),
`docs/API.md` / `docs/ARIA.md` / `README.md` (this round's
documentation). Zero new migrations; no protected file touched.

## Daily Brief + reminder times (Phillip, 8 July 2026, migration 041)

A single shared team brief (v1 — not per-user, see `user_id`'s own
column comment) on the My Work page: a sticky-note acknowledgement
layer over the existing attention feeds. Ticking an item means
"seen/handled" — it NEVER completes the underlying record; `link_href`
("open ->") is how you action the real thing.

**Admin-gated, v1.** Every `/api/brief*` route below returns 403 for a
non-admin session. The brief mixes admin-only-sourced rows (leads
nurture/stale, ordering_due) with team-visible ones (bookings, trade
proposals, insurance) into one shared feed — splitting it per-role
would either leak admin-only titles/links to non-admins or require
maintaining two divergent brief views, so the whole feed is gated
rather than per-source (unlike `GET /api/my-work`, which gates
per-source since each of ITS sources renders as its own independent
list). `components/my-work/DailyBrief.tsx` treats a 403 as "render
nothing" — a non-admin's My Work page simply shows no Daily Brief
section, no error banner.

- **`GET/POST /api/brief/generate`** (**session, admin-only** OR
  `CRON_SECRET` bearer) — runs the generator: aggregates bookings
  overdue, ordering_due, lead nurture/stale, trade proposed_change, and
  expiring/expired insurance into `daily_brief_items` rows. **Dedupe/
  idempotency**: a candidate is skipped when an OPEN item already
  exists with the same `(source, link_href)` within the last 7 days —
  running this route twice in a day (the cron entry, plus a manual
  "regenerate") produces zero duplicates. An item nobody ticks stays
  open indefinitely — it isn't re-created, it just keeps showing up on
  every `GET /api/brief` call (which queries every OPEN item
  regardless of `brief_date`, not just today's), tagged "from
  yesterday" / "from {weekday}" by how old its `brief_date` is. See
  `lib/daily-brief.ts`'s and `lib/daily-brief-generate.ts`'s own header
  comments for the full derivation. `?send=1` additionally sends the
  7am glance email (see below) after generating — see `README.md`'s
  "Daily Brief cron" section for the exact `vercel.json` entry and its
  DST caveat.
- **`GET /api/brief`** (**session, admin-only**) — "today's open +
  recent done": every OPEN item (any `brief_date`) plus every DONE item
  whose `acknowledged_at` falls within the last 24 hours (so a
  carried-over item ticked done today still counts toward today's
  done/total). Each item is annotated with `project` (resolved from
  `project_id`), `carried_over_label` (null for a genuinely-today item),
  and `converted_label` ("added to {project}" / "added to Office",
  derived from `converted_task_id`/`converted_office_task_id` at read
  time — never stored, see the migration's own "no note column" doc
  comment).
- **`POST /api/brief/items`** (**session, admin-only** OR Bearer JWT —
  Aria's account) — manual/Aria add. body `{ title, source? ('manual'
  default | 'aria'), link_href?, project_id? }`. This is the
  `add_brief_item` MCP tool's target route.
- **`PATCH /api/brief/items/[id]`** (**session, admin-only**) — tick/
  untick. body `{ status: 'open' | 'done' }`. Untick clears
  `acknowledged_at` back to null (fully reversible, same as Office
  board's complete/uncomplete pair).
- **`POST /api/brief/items/[id]/convert`** (**session, admin-only**) —
  "Add to project ->". body `{ project_id?: string | null }`.
  - `project_id` given: creates a `board_tasks` row (title from the
    item, due today, the project's first board column — seeded if the
    project's board has never been opened — and first board group as
    defaults), sets `converted_task_id`, auto-ticks the brief item.
  - `project_id` omitted/null: creates an `office_tasks` row in the
    'Phillip' department group (matched by name, case-insensitive;
    falls back to the first office group if 'Phillip' doesn't exist),
    sets `converted_office_task_id` (a SEPARATE column from
    `converted_task_id` — see the migration's own "SECOND DEVIATION
    NOTE": an office task lives in a different table, so it can't be
    stored in a column FK'd to `board_tasks`), auto-ticks the item.
  - Refuses (400) a second conversion attempt on an already-converted
    item — one-shot per item.

**The 7am email** (`sendTeamEmail` to every admin profile, via
`?send=1` on the generate route): subject `"Daily brief — {date} · N
items"`, body = counts by source + up to 5 item titles + a link to
`{appUrl}/my-work`. Skips cleanly (no email sent, no error) when Gmail
isn't configured, there are zero open items, or there are zero admin
recipients — see `lib/daily-brief.ts`'s `buildBriefEmailContent()` for
the exact formatting and `app/api/brief/generate/route.ts`'s
`sendBriefEmailIfNeeded()` for the skip conditions.

### due_time ("Small pair" item 2, same migration 041)

`board_tasks`, `office_tasks`, and `design_tasks` all gain a nullable
`due_time time` column alongside their existing `due_date`. Every due-
date editor that previously offered just a date input now offers an
optional time beside it:

- **Board**: `DueDateCell` (`components/board/DateCell.tsx`) — the
  click-to-reveal popover gains a second `<input type="time">`,
  disabled until a date is set; commits `{ due_date, due_time }` as one
  PATCH pair, mirroring `WorksDateCell`'s own "commit once as a pair"
  discipline. `PATCH /api/board-tasks/[id]`'s `EDITABLE_FIELDS`
  whitelist gains `due_time`; `POST /api/projects/[id]/board` accepts
  it at creation too.
- **Office**: the expanded task row (`components/office/OfficeBoard.tsx`)
  gains a second `<input type="time">` beside the existing date input.
  `PATCH /api/office/tasks/[id]`'s whitelist and `POST
  /api/office/tasks`'s create body both gain `due_time` (never set for
  `kind: 'rule'` cards, same as `due_date`).
- **Design**: the expanded task row
  (`components/projects/design/DesignPhaseSection.tsx`) gains the same
  time input. `PATCH /api/design-tasks/[id]`'s whitelist and `POST
  /api/design-tasks`'s create body both gain `due_time`.
- **My Work** (`GET /api/my-work`): sources #1 (board_task), #6
  (office_task), and #8 (design_task) now select+return `due_time`.
  `lib/my-work.ts`'s `groupMyWorkItems()` sorts same-day items by time
  ascending (untimed items sort after every timed item that day) and
  shows `"2:30pm"` next to the date; `bucketFor()` moves a "today" item
  into the "overdue" (red) bucket once its `due_time` has passed, per
  BUILD-SPEC's "overdue turns red by datetime when time present, else
  by date" — a task with no `due_time` keeps the exact prior date-only
  rule.
- **Overdue check**: `lib/time-format.ts`'s `isOverdueByDateTime()` is
  the one shared implementation every surface above uses (board's
  `pastDue`, office's, design's, and `lib/my-work.ts`'s bucket logic) —
  Adelaide-anchored via `Intl.DateTimeFormat` STRING comparison
  (mirroring `ProjectBoard.tsx`'s existing `isPastDue()` fix), never a
  raw `Date` object comparison, to avoid the exact server(UTC)/client
  (Adelaide) hydration-mismatch bug class that fix already eliminated
  for date-only comparisons.
- **Aria**: `create_board_task`, `create_office_task`, and
  `create_design_task` (`mcp/src/index.mjs`) all accept an optional
  `due_time` ("HH:MM", 24h) alongside their existing `due_date`.

### MCP — `add_brief_item`

New tool, thin fetch to `POST /api/brief/items`. `{ title, link_href?,
project_id? }` — always lands with `source: 'aria'`. See
`docs/ARIA.md`'s "Daily Brief" section for when to use this instead of
WhatsApp.

**Files touched:** `supabase/migrations/041_brief_and_due_times.sql`
(new — see its own header for the file-number/schema deviation notes),
`lib/daily-brief.ts` (new), `lib/daily-brief-generate.ts` (new),
`lib/time-format.ts` (new), `types/round-daily-brief.ts` (new),
`app/api/brief/generate/route.ts` (new), `app/api/brief/route.ts`
(new), `app/api/brief/items/route.ts` (new),
`app/api/brief/items/[id]/route.ts` (new),
`app/api/brief/items/[id]/convert/route.ts` (new),
`components/my-work/DailyBrief.tsx` (new),
`components/my-work/MyWorkWorkspace.tsx` (mounts `DailyBrief` first),
`types/phase-12a-b.ts` (`due_time` on `BoardTaskWithAssignees`/
`CreateBoardTaskInputV2`/`PatchBoardTaskInputV2`/`MyWorkItem`),
`types/phase-13.ts` / `types/phase-12b.ts` (`due_time` on
office/design task types), `app/api/board-tasks/[id]/route.ts`,
`app/api/projects/[id]/board/route.ts`, `app/api/office/tasks/route.ts`,
`app/api/office/tasks/[id]/route.ts`, `app/api/design-tasks/route.ts`,
`app/api/design-tasks/[id]/route.ts`, `app/api/my-work/route.ts`,
`lib/my-work.ts`, `components/board/DateCell.tsx`,
`components/board/ProjectBoard.tsx`, `components/office/OfficeBoard.tsx`,
`components/projects/design/DesignPhaseSection.tsx`, `mcp/src/index.mjs`,
`README.md` / `docs/API.md` / `docs/ARIA.md` (this round's
documentation). No protected file touched.

## Site-visit lifecycle emails (Phillip, 9 July 2026, migration 043)

`docs/RESLU-Spec-Visit-Emails-Brief.md`: client-facing "your site visit
is booked" / "your site visit is tomorrow" emails, for both lead site
visits (`leads.site_visit_date`) and project client_events
(`starts_at`) — "applies to lead site visits AND project client_events"
per this round's BUILD-SPEC.md decision. Templates are placeholder
files (`emails/visit-confirmation.html`, `emails/visit-reminder.html`)
until CC copies the real, brand-approved versions from the website repo
(`reslu-site/emails/`) — see `emails/README.md`'s INSTALL STEP and
`README.md`'s "Site-visit lifecycle emails" section for the exact
on-machine steps (also covers `RESEND_API_KEY` and the cron entry).

### `email_sends` (migration 043_visit_emails.sql)

Doubles as BOTH the send-guard (never send the same template twice for
the same visit date/time) AND the 7am-7pm Adelaide sending-window
queue. `record_type` ('lead' | 'client_event') + `record_id` is a
polymorphic reference (no FK — two possible parent tables). `template`
is free text ('visit-confirmation' | 'visit-reminder' today; a future
milestone template per the brief's "Future milestones" section — brief
accepted, design presented, construction start, handover — needs no
migration, just a new `emails/<name>.html` file). `status` is
'pending' | 'sent' | 'skipped'. `detail` jsonb snapshots the merge data
used for that send/queue attempt, INCLUDING the visit datetime being
confirmed/reminded (`detail.visit_datetime`) and the rendered subject
line — this is what the guard compares against and what a queued
row's later flush re-renders from. See the migration file's own header
comment for the full design write-up.

### `lib/visit-emails.ts` — the one shared module

- `loadTemplate(name)` — reads `emails/<name>.html` off disk at
  runtime (server-only; cached per warm instance). Missing/unreadable
  file never crashes a trigger's primary action — logged as a
  `'skipped'` `email_sends` row + `reportError('visit-emails', ...)`.
- `merge(html, data)` — simple global `{{placeholder}}` replace,
  blank-safe (`{{first_name}}` `{{last_name}}` `{{visit_date}}`
  `{{visit_time}}` `{{suburb}}` `{{phillip_phone}}`, default
  `+61 439 870 594`).
- `suburbFrom(location)` — best-effort suburb heuristic off a free-text
  address string (no geocoder). Comma-separated input: last segment
  before any pure state/postcode segment, stripping a trailing
  state/postcode off a mixed segment (e.g. "Norwood SA 5067" ->
  "Norwood"). No commas: last one or two words before a trailing
  state/postcode. Returns `''` when neither strategy yields anything —
  callers must treat that as "omit gracefully in the merged copy", not
  a bug (a free-text field can always defeat a heuristic).
- `isWithinSendWindow(now)` / `nextAdelaide7am(now)` /
  `adelaideDayRangeUtc(dateStr)` — Adelaide-anchored, DST-safe via
  `Intl.DateTimeFormat` throughout (never a fixed UTC-offset constant),
  same technique as `app/api/digest/flush`'s `DIGEST_HOURS` gate and
  `lib/daily-brief-generate.ts`'s `adelaideToday()`.
- `sendViaResend({ to, subject, html, attachments? })` — plain `fetch`
  to `POST https://api.resend.com/emails` (no SDK), `reply_to:
  'phillip@reslu.com.au'`. **`from` — SUPERSEDED by the lead flow round
  (migration 048):** now `'Aria — RESLU <aria@reslu.com.au>'` (was
  `'Phillip — RESLU <visits@reslu.com.au>'` when this round originally
  shipped) — see this file's own "Lead flow" section below for the
  full write-up. `attachments` is also new as of that round (optional,
  additive). No-op `{ skipped: true, reason: 'no RESEND_API_KEY' }` when
  unconfigured; a real send failure throws (callers must not mark a row
  `'sent'` on a failed call).
- `sendOrQueue(supabase, input)` — the one entry point every trigger
  calls. GUARD: skips as `'duplicate'` if a `'sent'` row already exists
  for this `(record_type, record_id, template)` whose logged
  `detail.visit_datetime` equals the CURRENT visit datetime (brief:
  "Send once ... re-send only if date/time changed, with the same
  template") — a `'sent'` row logged against a DIFFERENT (rescheduled)
  datetime does NOT block a fresh send. WINDOW: inside 7am-7pm Adelaide,
  sends immediately via Resend and logs `'sent'`; outside the window,
  logs `'pending'` with `scheduled_for` = next 7am Adelaide.
- `flushPendingSends(supabase, now)` — sends every due (`'pending'`,
  `scheduled_for <= now`) row, re-rendering HTML from the row's own
  `detail` snapshot + the CURRENT template file on every flush (so a
  template fixed after a row was queued is picked up automatically). A
  no-op outside the send window.
- `cancelPendingSends(supabase, recordType, recordId)` — marks every
  still-`'pending'` row for a record `'skipped'` (rows already `'sent'`
  are left alone — nothing to undo).

### Trigger wiring

- **`PATCH /api/leads/[id]`** — fires only when `site_visit_date`
  actually CHANGES value. `LeadDetailPanel`'s single-save pattern sends
  `site_visit_date` on every save (the whole draft, not just the field
  touched), so the route reads the pre-update value first and compares
  it to the post-update value — an unrelated field save (site visit
  date unchanged) triggers nothing. On a real change: a non-null new
  value (with `leads.email` on file) first cancels any still-pending
  queued send left over from the PRIOR date/time, then sends/queues a
  fresh `visit-confirmation`; a cleared (null) value just cancels any
  still-pending queued sends for that lead. Fire-and-forget via
  `next/server`'s `after()`, own service-role client (work queued via
  `after()` can outlive the request/response cycle — same pattern as
  `app/api/items/[id]/route.ts`'s Monday sync kickoff).
- **`POST /api/leads`** — same confirmation trigger, for a lead created
  with `site_visit_date` already set (e.g. backdating/importing a lead
  that already had a booked visit).
- **`POST /api/projects/[id]/client-events`** — sends/queues a
  `visit-confirmation` to the project's `client_email` (+
  `client_secondary_email` when present) whenever the project has a
  `client_email` on file (`starts_at` is already a required field on
  this route). A SEPARATE send from `lib/client-event-reminders.ts`'s
  existing "day before" Gmail-based meeting nudge (generic content,
  gated on `client_events.reminder_sent_at`) — this is the brand
  `visit-confirmation.html` template via Resend, guarded/logged in its
  own `email_sends` table, not that column.
- **`DELETE /api/client-events/[id]`** — cancels any still-pending
  queued sends for that event (brief: "If a visit is cancelled before
  the reminder fires, don't send it").
- **`GET/POST /api/visit-emails/run`** — cron entry point (also
  admin-session-triggerable manually). Two passes: `flushPendingSends()`
  first, then a reminder sweep finding every non-cancelled lead site
  visit / client event happening TOMORROW (Adelaide-local calendar
  date) and calling `sendOrQueue()` with `template: 'visit-reminder'`
  for each — the same guard makes repeated daily cron runs idempotent
  (a visit already reminded for its current date/time is a silent
  no-op). Auth: `authorization: Bearer ${CRON_SECRET}` OR an
  authenticated ADMIN session (stricter than the digest/trade-
  reminders/client-events-remind cron routes' "any team session",
  since this route reads admin-only `leads` data directly). See that
  route file's own header comment for the exact `vercel.json` cron
  line and its documented DST caveat.

### `GET /api/visit-emails`

`?record_type=lead|client_event&record_id=<uuid>` — any authenticated
team member. Returns every logged `email_sends` row for the record,
newest first. Powers `components/shared/VisitEmailStatusChips.tsx`,
mounted on `LeadDetailPanel` (when `site_visit_date` is set) and each
`ClientEventsPanel` row — renders a compact line like "Confirmation
sent 8 Jul · Reminder pending" (nothing rendered until a visit email
has actually fired for that record).

**Files touched:** `supabase/migrations/043_visit_emails.sql` (new),
`types/visit-emails.ts` (new), `lib/visit-emails.ts` (new),
`emails/README.md` / `emails/visit-confirmation.html` /
`emails/visit-reminder.html` (new, placeholders — see INSTALL STEP),
`app/api/visit-emails/route.ts` (new), `app/api/visit-emails/run/route.ts`
(new), `app/api/leads/[id]/route.ts` (PATCH gains the confirmation/
cancel trigger), `app/api/leads/route.ts` (POST gains the confirmation
trigger), `app/api/projects/[id]/client-events/route.ts` (POST gains
the confirmation trigger), `app/api/client-events/[id]/route.ts`
(DELETE gains the cancel trigger), `components/shared/
VisitEmailStatusChips.tsx` (new), `components/leads/LeadDetailPanel.tsx`
/ `components/client-area/ClientEventsPanel.tsx` (mount the chip),
`next.config.ts` (`outputFileTracingIncludes` for `emails/**` on every
route that can reach `loadTemplate()`), `.env.local.example`
(`RESEND_API_KEY`), `README.md` / `docs/API.md` (this round's
documentation). No protected file touched; `lib/client-event-
reminders.ts` and `app/api/client-events/remind/route.ts` (the
existing "day before" Gmail meeting reminder) were read for context
but deliberately not modified — see the trigger-wiring note above on
how the two systems relate.

## Trade-scoped SOW extracts (8 July 2026)

BUILD-SPEC.md "Trade-scoped SOW extracts": "'Select all carpentry' ->
condensed scope per trade." Migration `044_sow_trade_tags.sql` adds
`sow_lines.trade text null` — single tag, free text (not a foreign
key — see the migration's own comment), matching an
`app_settings('export_presets')` preset **name** exactly (one
vocabulary everywhere: "trade-mapping presets," per the Order-by
engine section above's renamed Settings label).

### Auto-suggest heuristic — `lib/sow-trade-tags.ts`

`suggestTradeTag(lineText, presetNames)` — a line's leading CLAUSE
LABEL (`extractClauseLabel()`: the short all-caps run before an
em-dash/hyphen/colon, e.g. `"WALL TILING — {{...}}"` -> `"WALL
TILING"`) is matched against a fixed keyword table, then resolved
against the studio's CURRENT preset names (case-insensitive; only
suggests a preset that actually exists):

| Clause-label keyword(s) | Suggested trade |
|---|---|
| WALL TILING, FLOOR FINISHES, WATERPROOFING | Tiler |
| JOINERY | Carpenter |
| SANITARYWARE, TAPWARE | Plumber |
| ELECTRICAL, LIGHTING | Electrician |
| PAINTING | Painter |
| PARTITIONS, PLASTER | Plasterer |
| DEMOLISH | Demolition |
| SHOWER SCREEN | Glazier |
| STONE | Stonemason |

Deliberately a PREFIX match (the line's own leading clause label), not
"keyword anywhere in the text" — a General Notes clause like
"Waterproofing to all wet areas per AS 3740-2010..." contains the word
"Waterproofing" too, but isn't a `"WATERPROOFING — ..."` labelled
clause; a naive substring-anywhere scan would mis-tag it as Tiler. A
line with no clause label, or whose canonical suggestion has no
matching current preset, is left untagged (`trade: null`) — never
guessed in, per BUILD-SPEC's own wording.

**Applied automatically** by `POST .../sow/[sowId]/from-template` —
every ROOM section's lines (not the Project Overview / General Notes /
Site Management / Exclusions library groups, which have no clause
label to match and would risk the false-positive above) are tagged at
insert time. **One-click "Suggest trade tags"** —
`POST /api/projects/[id]/sow/[sowId]/suggest-trade-tags` — re-runs the
same heuristic against every currently-UNTAGGED line in an existing
draft SOW (any section), for content that predates auto-suggest or a
hand-built SOW. Response `{ lines, tagged_count }`; only fills gaps,
never overwrites a deliberate tag/retag. 400 if the SOW is issued
(read-only, same rule every other SOW mutation route enforces).

### Tagging in the builder

`components/sow/SowBuilder.tsx`: every editable line row gains a
compact trade `<select>` (options: current preset names + a blank
"— trade —" that clears the tag) between the kind select and the text
input — renders as a small solid sand chip once a value is set, a
muted outline while blank. Read-only (issued) rows show the tag as the
same sand chip, no select. `PATCH /api/sow/lines/[lineId]`'s body gains
`trade?: string | null` (explicit `null` clears, `undefined`/absent
leaves unchanged — same convention as `text`/`kind`/`sort`); free text,
no validation against the current preset list (a line tagged with a
since-renamed/deleted preset name keeps its value, shown with a "(no
longer a preset)" suffix in the select rather than silently vanishing).

### Extract composition — `filterSectionsForTrade()`

Shared by both PDF routes below, so team-facing and trade-facing
extracts can never drift:

- **General Notes sections** (`isGeneralNotesHeading`: heading starts
  with "General Notes", case-insensitive — matches
  `lib/sow-templates.ts`'s three template headings) -> **included in
  full**, untouched, regardless of any line's tag.
- **The Exclusions section** (`isExclusionsHeading`: heading trims to
  exactly "Exclusions", case-insensitive) -> **included in full**,
  untouched.
- **Every other section** (Project Overview, Site Management &
  Handover, every room section, any custom section) -> filtered to
  only the lines whose `trade` exactly equals the requested trade;
  untagged lines and lines tagged for a different trade are dropped. A
  section left with zero lines after filtering is **omitted entirely**
  (never rendered as an empty heading).

CHOSEN OVER a `sort < first-room-section-sort` positional rule (the
brief's own alternative) because heading text survives section
reordering and a hand-built SOW with no room sections to compare
against — see `lib/sow-trade-tags.ts`'s own doc comment for the full
rationale.

### `GET /api/projects/[id]/sow/[sowId]/pdf?trade=<preset name>`

Extends the existing route (unchanged when `trade` is absent). Renders
`components/pdf/SowPdf.tsx` with the filtered section set and its new
`extractTrade` prop, which adds ONE cover subtitle line — `"{Trade}
scope — extract of {project name} · Rev {revisionLabel}"` — directly
under the address/description text; every other cover element and the
ENTIRE body pagination/wrap structure (the `View key={section.id}` /
per-line `wrap={false}` shape from the earlier pagination-fix round) is
byte-for-byte unchanged. Filename gains a trade slug. **Cache-aware
check performed:** this route is `dynamic = "force-dynamic"` with
`Cache-Control: no-store` already — no caching layer exists to key on
the new query param.

### Doc-pack integration — trade booking pack

`types/trade-doc-pack.ts`'s `DocumentPackChoices` gains
`include_sow_trade: string | null` (always present, plain nullable —
no third state to encode, unlike `schedule_categories`) — the booked
CONTACT's matched trade preset name, frozen at booking time by
`components/board/BookVisitPanel.tsx` via the SAME
`pickPresetForContactCategory()` resolution the Schedule auto-pick
already uses (its own independent `useMemo`, not a re-read of the
Schedule row's own state — a staff member's Schedule "Change" pick
must never silently redirect the SOW trade preference). Checkbox copy
shows the resolved preview: `"Scope of Works — {Trade} extract
({label})"` when a trade is resolved, else unchanged.

**Resolution is re-checked fresh, not frozen** (same "frozen choices,
live revisions" split every other `document_pack` field already
follows): `app/trade/[token]/page.tsx`'s DOCUMENTS section, on every
render, checks whether the pack's `include_sow_trade` CURRENTLY has
>=1 tagged line in the latest issued SOW (`sow_sections` filtered via
an embedded `sow_lines!inner(trade)` + `.eq("sow_lines.trade", ...)`,
same embedded-filter pattern `app/api/projects/[id]/handover/route.ts`
already uses) — if yes, the row's href gains `?trade=<name>` and the
label reads `"Scope of Works — {Trade} extract ({revisionLabel})"`; if
no (nothing tagged for that trade yet, or no trade preference at all),
it falls back to the full-document href/label, unchanged from before
this round. `GET /api/trade/[token]/documents/sow` itself also gains
the same optional `?trade=` param, applying the identical
`filterSectionsForTrade()` — this route does no independent
re-validation of the page's decision (low risk: an extract is a subset
of information the trade could already see in the full document if
`include_sow` was ticked).

**Files touched:** `supabase/migrations/044_sow_trade_tags.sql` (new),
`types/sow-trade-tags.ts` (new), `lib/sow-trade-tags.ts` (new —
`TRADE_KEYWORD_TABLE`, `extractClauseLabel`, `suggestCanonicalTrade`,
`resolveAgainstPresets`, `suggestTradeTag`, `isGeneralNotesHeading`,
`isExclusionsHeading`, `filterSectionsForTrade`, `distinctTaggedTrades`,
`isUntagged`), `app/api/sow/lines/[lineId]/route.ts` (PATCH whitelist
gains `trade`), `app/api/projects/[id]/sow/[sowId]/from-template/route.ts`
(room-section auto-tag at insert), `app/api/projects/[id]/sow/[sowId]/
suggest-trade-tags/route.ts` (new), `components/sow/SowBuilder.tsx`
(trade select/chip, "Suggest trade tags" action, trade-chip download
group), `components/pdf/SowPdf.tsx` (`extractTrade` prop + one cover
subtitle line — pagination/wrap structure untouched), `app/api/projects/
[id]/sow/[sowId]/pdf/route.ts` (`?trade=` param), `types/trade-doc-
pack.ts` (`DocumentPackChoices.include_sow_trade`), `components/board/
BookVisitPanel.tsx` (`bookedTradeName` resolution, `include_sow_trade`
on the frozen pack, checkbox copy), `app/trade/[token]/page.tsx`
(fresh tagged-line re-check, extract vs. full SOW row resolution),
`app/api/trade/[token]/documents/sow/route.ts` (`?trade=` param),
`docs/API.md` / `README.md` (this round's documentation). Single
migration (044); no protected file touched — `types/index.ts` in
particular was deliberately left untouched, with every SOW-line-plus-
trade shape declared locally in `types/sow-trade-tags.ts` instead (same
per-round-own-file convention every other additive round in this
directory already follows).

## CPD point tracker (migration 047)

BUILD-SPEC.md "CPD point tracker" — the section's own placeholders
(exact annual target, licence-year start month, CBS category split)
were never resolved to real regulatory numbers, so this round ships
sensible, ADMIN-EDITABLE defaults instead of guessing: **12 points/year,
licence year starting July**, both editable at Settings -> "CPD"
(`app_settings` key `cpd_defaults`, `lib/cpd.ts`
`FALLBACK_CPD_DEFAULTS`). Category is free text with a `<datalist>` of
suggestions (Technical/Business/Compliance/Safety) — no CHECK
constraint, since the real CBS split was never specified. **Per-user
override is explicitly SKIPPED in v1** — one studio-wide target/
year-start applies to every team member; see `lib/cpd.ts`'s
`FALLBACK_CPD_DEFAULTS` doc comment for the extension point a future
round would need (a nullable per-profile override column).

### `cpd_entries` (migration `047_cpd.sql`)

One row per logged CPD activity: `user_id` (not null, references
`profiles`), `activity_title`, `provider`, `activity_date` (date, not
null), `points` (`numeric(5,2)`, check `> 0`), `category` (free text),
`evidence_path`/`evidence_filename` (private `assets` bucket, see
below), `notes`, soft-delete via `deleted_at`. Index on
`(user_id, activity_date)` for the two hot query shapes (the CPD page's
own list, and the My Work nudge's points-to-date sum).

RLS is the house-standard permissive `team_all` (single policy, `using
(true) with check (true)`) — **the API layer is the real gate**, same
shape as every other Phase 1 table: every route scopes WRITES
(POST/PATCH/DELETE) to the caller's own `user_id` unless the caller is
admin, who may act on any user's row. Admins may also **view** every
team member's entries (`GET ?all=1`) — CPD records are not financial
data, so this is a lighter gate than `client_invoices`'s admin-only-
everything shape.

### `lib/cpd.ts` — the one shared module

Pure, dependency-free (no Supabase/Next imports) — mirrors
`lib/my-work.ts` / `lib/export-presets.ts`'s exact shape, consumed by
BOTH the API routes and the client UI so the year-window math and pace
check can never drift:

- `computeCpdYearWindow(now, yearStartMonth)` — the current licence-
  year window containing `now`, INCLUSIVE end date (e.g.
  `yearStartMonth=7`, any date in Jul 2026-Jun 2027 ->
  `{ start: '2026-07-01', end: '2027-06-30' }`).
- `elapsedFraction(now, window)` — 0..1, how far through the window
  `now` sits.
- `monthsElapsedSinceStart(now, window)` — whole calendar months since
  `window.start`.
- `isBehindPace(pointsToDate, annualTarget, now, window)` — the My Work
  nudge's exact rule: `pointsToDate < annualTarget * elapsedFraction`,
  but only once `monthsElapsedSinceStart >= 2` (a fresh licence year's
  first ~2 months never nudges — a pro-rata target of ~1 point is
  noise that early).
- `cleanCpdEntryFields()` / `cleanCpdDefaults()` — shared create/edit
  validation, same "small pure validator, reused by both routes" shape
  as `lib/bank-details.ts` `cleanBankDetails()`.
- `cpdEntriesToCsv(entries, personLabel)` — the CSV export builder (see
  below).

### `GET /api/cpd` / `POST /api/cpd`

Auth: session. `GET` defaults to the signed-in user's own, non-deleted
entries for the CURRENT licence-year window, alongside `defaults` and
the resolved `window` (so the page never needs a second Settings
round-trip to render its header). `?all=1` (**admin only** — silently
ignored, not 403'd, for a non-admin, same "UI toggle hint, not a
security boundary" shape as other optional query params in this
codebase) returns every team member's entries for the same window, each
carrying a `profile: { id, full_name }` projection so the "All team"
view can group by person client-side without a second round-trip.

`POST` always writes with the caller's own `user_id` **UNLESS the
caller is admin and passes `user_id` explicitly** — the one deliberate
escape hatch, used exclusively by the `add_cpd_entry` MCP tool (Aria's
account is admin) to attribute an entry to a team member resolved from
an email address. A non-admin's `user_id` field, if present, is
silently ignored (forced to their own id). `evidence_path`/
`evidence_filename` come from the two-step signed-upload flow below,
already-uploaded by the time this POST fires.

### `PATCH /api/cpd/[id]` / `DELETE /api/cpd/[id]`

Auth: session, **own entry only, unless admin** (may act on any row) —
the ownership check is the real gate (a forged id belonging to another
user's entry 404s for a non-admin), same enforcement shape as `PATCH
/api/my-work/notes/[id]`. `PATCH` accepts a partial body; passing
`evidence_path: null` clears any existing evidence AND removes the
Storage object; passing a new `evidence_path` replaces it, removing the
old object once the row update succeeds. `DELETE` soft-deletes the row
(`deleted_at`) and immediately removes any evidence Storage object —
same "soft-delete the row, hard-delete the file" shape as `DELETE
/api/contact-documents/[id]`.

### `POST /api/cpd/evidence/upload-url`

Mints a signed upload URL for a CPD evidence file (certificate,
confirmation email PDF, screenshot), same two-step flow as
`ContactDocumentsPanel.tsx` / `POST /api/contacts/[id]/documents/
upload-url`. Keyed by the caller's OWN `user_id`
(`cpd/{user_id}/{timestamp}-{slug}`), **not** by a `cpd_entries` row id
— unlike `contact_documents`, a CPD entry doesn't exist yet at upload
time (the add form uploads evidence BEFORE the entry is created, then
includes the resulting `path` directly in the `POST /api/cpd` body).
Private `assets` bucket (migration 009) — every read mints a fresh
short-TTL signed URL server-side, never a stored/cached one.

### `GET` / `PUT /api/settings/cpd-defaults`

`GET`: session (team-visible read — every team member's `/cpd` page
needs these). `PUT`: admin only. Body `{ annual_target, year_start_month
}`, upserts `app_settings('cpd_defaults')` — same generic key/value
store every other Settings editor in this codebase already uses.

### `/cpd` page

Header progress: `"{points-to-date} / {target} points · Licence year
ends {date}"`, a sand progress bar (full width + "Target reached" label
once at/over target). Entries list: date, title, provider, points,
category chip, evidence link (freshly-signed URL), edit/delete own (or
any, if admin). Single-save add/edit form (mobile-friendly grid,
collapses to one column) — title, provider, date (defaults to today),
points, category (`<datalist>` suggestions, free text underneath),
evidence file (optional), notes. Admin-only "All team" checkbox toggles
a second fetch (`?all=1`) that replaces the flat list with entries
grouped by person, each with their own mini progress bar. "Download
CSV" builds a CSV **client-side** from whatever's currently loaded
(own or all-team) via `lib/cpd.ts` `cpdEntriesToCsv()` — audit-friendly
columns (Date, Activity, Provider, Category, Points, Notes, Logged by,
Evidence on file). **No CSV-export precedent existed elsewhere in this
codebase to reuse** (`lib/csv.ts` is the project-IMPORT parser, a
different direction entirely, and is out of this round's edit
boundary) — this is a small from-scratch builder. **PDF export is
explicitly deferred** to a future round (noted in the page itself).

### My Work — "cpd_nudge" additive source

`GET /api/my-work` gains source #10 (see that route's own doc comment):
when the signed-in user's CPD points-to-date are behind pro-rata pace
(`lib/cpd.ts` `isBehindPace()`), one `MyWorkItem` of kind `cpd_nudge`
is appended — `due: null` (lands in the "No date" bucket — there's no
natural due date for a pace check), title `"CPD: {points} / {target}
points — behind pace"`, linking `/cpd`. Per-user, **not** admin-gated
(unlike `lead_follow_up`/`ordering_due`) — every team member sees their
own pace. At most one item of this kind per response, unlike every
other source. `types/phase-12a-b.ts`'s `MyWorkItemKind` gains
`"cpd_nudge"`; `components/my-work/MyWorkWorkspace.tsx` gains a
`KIND_LABEL` entry and a small `projectlessChipLabel()` helper
(replacing what used to be a two-way `office_task`/`Lead` ternary, now
three-way).

### MCP — `add_cpd_entry`

Per `docs/ARIA.md`'s "CPD logging" section: when a webinar/course
confirmation email lands in the shared inbox, Aria logs it via this
tool rather than leaving it for manual entry. Thin fetch to `POST
/api/cpd` — resolves `user_email` (defaults to `phillip@reslu.com.au`
when omitted) against `GET /api/profiles`, then passes the matched
profile id as the admin-only `user_id` field. **Evidence attachment is
deferred** — the tool never sets `evidence_path` (no natural fit for a
two-step signed-upload inside one MCP call); mention the confirmation
email's existence in `notes` instead. Wiring an automated
"forward confirmation email -> attach as CPD evidence" pipeline is a
future round, not this one.

**Files touched:** `supabase/migrations/047_cpd.sql` (new),
`types/cpd.ts` (new), `lib/cpd.ts` (new), `app/api/cpd/route.ts` (new —
GET/POST), `app/api/cpd/[id]/route.ts` (new — PATCH/DELETE),
`app/api/cpd/evidence/upload-url/route.ts` (new),
`app/api/settings/cpd-defaults/route.ts` (new — GET/PUT),
`app/(dashboard)/cpd/page.tsx` (new), `components/cpd/CpdWorkspace.tsx`
(new), `components/settings/CpdDefaultsSettings.tsx` (new),
`app/(dashboard)/settings/page.tsx` (new "CPD" section, reads
`cpd_defaults` server-side same as every other app_settings editor),
`components/layout/Sidebar.tsx` (new "CPD" nav item, between Library
and Address Book), `app/api/my-work/route.ts` (additive source #10),
`types/phase-12a-b.ts` (`MyWorkItemKind` gains `cpd_nudge`),
`components/my-work/MyWorkWorkspace.tsx` (`KIND_LABEL` entry +
`projectlessChipLabel()`), `mcp/src/index.mjs` (`add_cpd_entry` tool),
`docs/API.md` / `docs/ARIA.md` / `README.md` (this round's
documentation). Single migration (047); no protected file touched —
`types/index.ts` in particular was deliberately left untouched, with
every CPD shape declared locally in `types/cpd.ts` instead (same
per-round-own-file convention every other additive round in this
directory already follows). The client-invoicing round's own files
(migration 046, `lib/client-invoices.ts`, `lib/bank-details.ts`,
`lib/resend.ts`, `components/pdf/InvoicePdf.tsx`,
`components/invoices/ClientInvoiceQueue.tsx`, `app/api/client-invoices/
**`, the bank-details Settings section) were also untouched — this
round shares Settings' page shell (additively, a new section) but
nothing else.

## Lead flow (10 July 2026, migration 048)

`docs/RESLU-lead-flow-brief.md` + `docs/DESIGNER-NOTES.md`: wires the
designer-built "paper card" client journey into the r15 "Site-visit
lifecycle emails" machinery above — real `visit-confirmation.html` /
`visit-reminder.html` templates (superseding the r15 placeholders) and
a new interactive `project-brief.html` pre-visit questionnaire, all
staged in `emails/`.

**BUILD-SPEC.md NOTE:** this round's task brief also cites
"BUILD-SPEC.md section 'Lead flow package'" as a reconciliation source.
No file named `BUILD-SPEC.md` exists anywhere in this working copy
(`find . -iname "*build*spec*"` returns nothing, checked before writing
this section) — `docs/RESLU-lead-flow-brief.md` and
`docs/DESIGNER-NOTES.md`'s own CORRECTIONS section are the sole
authoritative brief this round follows, same "flag it, don't invent
content" convention as migration 041's own file-number note.

### Migration `048_lead_brief.sql`

`leads` gains: `brief_token text unique` (nullable — minted lazily, see
below), `brief_answers jsonb`, `brief_submitted_at timestamptz`,
`visit_ics_sequence int not null default 0`. No RLS change — the
public `/brief/[token]` page and its submit route use the
service-role client (same trust model as `/trade/[token]`/
`/portal/[token]`).

**Visit TIME finding:** `leads.site_visit_date` is already a
`timestamptz` (migration 014) carrying the full date AND time of day,
not a date-only column — r15's `formatVisitTime()` already derives
`{{visit_time}}` ("10:00am") straight from it. **No new time column
was needed** for this round; the brief's "if no time field exists add
`site_visit_time`" branch does not apply. (Also avoids ever needing to
touch `types/index.ts`'s `Lead` interface for a new field — that file
is protected for this round.)

### `GET /brief/[token]`

Public, unauthenticated, token-gated (`leads.brief_token`), rate-
limited, `X-Robots-Tag: noindex, nofollow`, service-role client — same
trust model as `/trade/[token]`. Serves `emails/brief/project-brief
.html` **verbatim** (`lib/brief-page.ts`'s `loadBriefPageHtml()` — read
once off disk, cached): the page has no `{{placeholder}}` tokens at
all (it fills itself in client-side as the client types), so one cached
HTML string is correct for every lead's token. The ONE edit made to
the shipped file itself was rewiring its submit handler (previously a
commented-out `fetch` example, ~line 439) to
`POST /api/brief-submit/[token]`, reading the token from
`location.pathname` client-side. 404 on an unknown/deleted-lead token.

**MIDDLEWARE GAP (documented, not worked around):**
`lib/supabase/middleware.ts` (protected) does not yet allowlist
`/brief` or `/api/brief-submit` in its `isPublicPath` check, so an
unauthenticated request to either route is currently redirected to
`/login` before reaching the handler. Both routes are fully built and
correct; they just need this one addition, alongside the existing
`/trade`/`/api/trade` lines:

```ts
pathname.startsWith("/brief") ||
pathname.startsWith("/api/brief-submit") ||
```

### `POST /api/brief-submit/[token]`

Public, unauthenticated, token-gated, rate-limited tighter (10/min)
than the page GET. Deliberately **not** under `/api/brief/**` — that
prefix already belongs to the unrelated "Daily Brief" attention-items
feature (`app/api/brief/route.ts` + `app/api/brief/items/**`, migration
041) — this round's own instructions name the route
`/api/brief-submit/[token]` specifically to avoid that collision. Body:
`FormData` (the page posts `new FormData(form)`, not JSON) with the 10
fields `first_name, last_name, hoping, favourite_spaces, materials,
feel, must_1, must_2, must_3, bringing` — stored verbatim into
`leads.brief_answers`, `brief_submitted_at` set to now. **Idempotent
re-submit:** a second POST against the same token fully overwrites
`brief_answers`, keeping the PRIOR submission's timestamp as a
`_previous_submitted_at` note inside the new blob. Also inserts one
`daily_brief_items` row (`source: 'lead'` — already an allowed value
per migration 041's CHECK constraint; direct insert, not routed
through the generator) titled `Brief submitted — {surname_project}`,
`link_href: /leads?lead={id}` (same link shape as `lib/daily-
brief.ts`'s existing `buildLeadCandidates()`), guarded against a
duplicate still-OPEN row for the same source+link_href+title.

### `lib/lead-brief.ts`

- `briefUrlFor(token)` — `NEXT_PUBLIC_APP_URL`/`VERCEL_URL`-aware URL
  builder, same shape as `lib/portal-link.ts`'s `portalUrlFor()`.
- `ensureBriefToken(supabase, leadId, currentToken)` — returns the
  existing token, or mints (`crypto.randomBytes(32).toString("hex")` —
  same shape as `lib/projects.ts`'s `client_token` regeneration) +
  stores a fresh one. Called from `GET/POST /api/visit-emails/run`'s
  lead reminder sweep, the FIRST time a given lead's reminder needs to
  build `{{brief_link}}` — per this round's own build instructions:
  "Token: generated lazily when the reminder email builds
  `{{brief_link}}`."
- `buildLeadVisitCalendarAssets(leadId, visitDatetime, sequence, phone)`
  — the `{{calendar_link}}` + `invite.ics` Resend-attachment pair for
  one lead-visit send. Centralised here since all three trigger sites
  (`PATCH /api/leads/[id]`, `POST /api/leads`, the reminder sweep) need
  exactly this pair.

### `lib/ics.ts` additions — `generateVisitIcs()` / `leadVisitGoogleCalendarUrl()`

Distinct from the existing `generateIcs()`/`googleCalendarUrl()`
(untouched — still power `GET /api/leads/[id]/calendar.ics` and
`LeadDetailPanel`'s own "Add to calendar" menu):

- **`generateVisitIcs({ leadId, start, end?, sequence, phone? })`** —
  `METHOD:PUBLISH`, a real `VTIMEZONE` block for `Australia/Adelaide`
  (DST-correct since the 2008 rule change), `DTSTART`/`DTEND` in
  Adelaide LOCAL wall-clock time with `;TZID=Australia/Adelaide`
  (rather than `generateIcs()`'s deliberate bare-UTC-`Z` choice — see
  that function's own header comment for why THAT approach suits its
  callers), `SUMMARY:Site Visit · RESLU`, `LOCATION:219 Sturt Street,
  Adelaide SA 5000`, `ORGANIZER` `aria@reslu.com.au`, stable
  `UID:lead-visit-{leadId}@reslu.com.au`, `SEQUENCE` per input.
- **`leadVisitGoogleCalendarUrl(start, end?, phone?)`** — the
  `{{calendar_link}}` merge value, built to match
  `docs/RESLU-lead-flow-brief.md`'s literal worked example
  character-for-character via a hand-rolled encoder (`gcalValueEncode`)
  rather than `URLSearchParams`/`encodeURIComponent` — both of THOSE
  percent-encode `/` and `,` (confirmed before writing this), which the
  brief's own example leaves raw in `dates=<start>/<end>`,
  `ctz=Australia/Adelaide`, and the location. Fixed 1-hour default
  duration, `ctz=Australia/Adelaide`, location + details (with phone)
  exactly as specified.

**SEQUENCE mechanics (RFC 5545 §3.8.7.4):** `leads.visit_ics_sequence`
starts at 0. `PATCH /api/leads/[id]`'s existing site-visit-change
handler increments it by 1 (persisted immediately, then read into the
new invite) whenever `site_visit_date` changes to a new non-null value
on an ALREADY-booked visit (i.e. `previousSiteVisitDate` was non-null —
a genuine reschedule, not the first booking). NOT incremented on a
first booking or a cancellation. The reminder sweep re-sends the SAME
current sequence (no change happens there). Net effect: a reschedule's
re-sent `invite.ics` shares the SAME `UID` with a higher `SEQUENCE`, so
Apple Mail/Outlook/Google Calendar update the existing calendar entry
in place instead of duplicating it.

### `lib/visit-emails.ts` deltas

- **Sender identity SWAP:** `RESEND_FROM` is now
  `'Aria — RESLU <aria@reslu.com.au>'` (was `'Phillip — RESLU
  <visits@reslu.com.au>'`), per `docs/RESLU-lead-flow-brief.md`'s
  "Sending" section — both templates are now the real, brand-approved
  ones, and the designer's journey guide specifies this identity.
  `RESEND_REPLY_TO` is unchanged (`phillip@reslu.com.au`). This is a
  SHARED constant — it also changes the FROM address on the
  client_events reminder path (r15), since both record types render
  the exact same two template files and no separate identity was ever
  specified for client_events in this round's brief.
- **`merge()`/`VisitEmailMergeData`** gain `calendar_link` and
  `brief_link` (both blank-safe, same contract as every existing key).
- **`sendViaResend()`/`sendOrQueue()`** gain an optional `attachments`
  parameter (`ResendAttachment[]`, from `lib/resend.ts`) — used for
  `invite.ics`. Stored inside the `email_sends.detail` jsonb snapshot
  (see `types/visit-emails.ts`'s `VisitEmailDetail.attachments`) so a
  QUEUED send (outside the 7am-7pm window) still carries its attachment
  through to `flushPendingSends()`'s later, separate send attempt.
- **`DEFAULT_PHILLIP_PHONE`** is now exported (was module-private) —
  reused by the three lead-visit-email trigger sites when building
  calendar assets.

### Reminder cron window — `GET/POST /api/visit-emails/run`

**LEAD site visits only:** window changed from "tomorrow" (`+1` day)
to **"the Adelaide calendar day two days from today"** (`+2` days).
Honest caveat (documented in the route's own header comment): this is
a once-daily cron, so an exact 48-hours-out sweep is impossible — "the
Adelaide day two days from now" is the closest whole-day approximation
to the brief's "48 hours before the visit," landing anywhere from ~36h
to ~60h out depending what time of day the visit itself is booked for.
Now also builds `{{brief_link}}` (minting the lead's `brief_token` via
`ensureBriefToken()` on first need) and `{{calendar_link}}` +
`invite.ics` for each lead reminder send; subject line dropped the word
"tomorrow" (no longer accurate for this ~2-day window).

**CLIENT EVENTS: UNCHANGED** — still "tomorrow" (`+1` day), per that
feature's own separate brief (`docs/RESLU-Spec-Visit-Emails-Brief.md`,
"the day before"); this round's brief never discusses client_events, so
its window was deliberately left alone. Both windows are computed from
the same `now` inside one `handle()` call — no `vercel.json` change
needed, the existing single daily cron line covers both.

### `POST /api/leads/[id]/stage` — "Lead Lost" cleanup

`docs/RESLU-lead-flow-brief.md`'s Rules section: "When a lead is set
to Lost: clear its follow-up date, and cancel any pending reminder for
it." Moving a lead's stage TO `'Lead Lost'` (any other stage move is
unaffected) now also sets `follow_up_date = null` in the same update,
and calls `lib/visit-emails.ts`'s `cancelPendingSends()` for that lead
(rows already `'sent'` are left untouched).

### `components/leads/LeadDetailPanel.tsx` — "Project brief" section

Read-only render of `leads.brief_answers`, shown once
`brief_submitted_at` is set. Each answered field (blank ones are
skipped) renders with pen-blue (`#274690`) text — the one brand accent
borrowed from the card design, per this round's own "pen-blue accents
optional but keep brand" instruction. `draft` (typed `Lead`, protected)
is cast to `LeadWithBriefFields` (`types/round-lead-flow.ts`) for this
section only — a type-only widening, not a runtime shape change.

### Merge audit (this round's own verification pass)

Every `{{placeholder}}` actually present in the three staged files,
grepped before writing this section:
- `visit-confirmation.html`: `{{first_name}}` `{{visit_date}}`
  `{{visit_time}}` `{{calendar_link}}` `{{phillip_phone}}` — all merged.
- `visit-reminder.html`: same five, plus `{{brief_link}}` — all merged.
- `project-brief.html`: none (confirmed by grep) — see the `GET
  /brief/[token]` section above for why that's correct, not a gap.

**Files touched:** `supabase/migrations/048_lead_brief.sql` (new),
`types/round-lead-flow.ts` (new), `lib/lead-brief.ts` (new),
`lib/brief-page.ts` (new), `lib/ics.ts` (additive —
`generateVisitIcs`/`leadVisitGoogleCalendarUrl`, `generateIcs`/
`googleCalendarUrl` untouched), `lib/visit-emails.ts` (sender swap,
`merge()`/`VisitEmailMergeData`/`sendOrQueue`/`sendViaResend`/
`flushPendingSends` additions, `DEFAULT_PHILLIP_PHONE` exported),
`types/visit-emails.ts` (`VisitEmailDetail` gains `calendar_link`,
`brief_link`, `attachments`), `app/brief/[token]/route.ts` (new),
`app/api/brief-submit/[token]/route.ts` (new),
`app/api/leads/[id]/route.ts` (PATCH gains SEQUENCE increment +
calendar assets), `app/api/leads/route.ts` (POST gains calendar
assets), `app/api/leads/[id]/stage/route.ts` ("Lead Lost" cleanup),
`app/api/visit-emails/run/route.ts` (split reminder windows + calendar
assets for leads), `components/leads/LeadDetailPanel.tsx` ("Project
brief" section), `next.config.ts` (`outputFileTracingIncludes` gains
`/brief/[token]`), `.env.local.example` (Resend from-address note),
`emails/brief/project-brief.html` (submit handler wired — the only
edit to the shipped card HTML, per the brief's own "beyond inserting
the endpoint URL" allowance), `emails/README.md` (rewritten —
placeholders no longer placeholders), `README.md` / `docs/API.md` (this
round's documentation). Single migration (048); no protected file
touched — `types/index.ts`, `lib/supabase/middleware.ts`, `vercel.json`,
and every other file on this round's protected list were read for
context but never edited. The middleware gap is documented above and
in `README.md`'s "Lead flow" section, not silently worked around.

## Grouped trade booking (10 July 2026, migration 049)

`docs/BUILD-SPEC.md` §"Grouped trade booking (r20)": booking one trade
for several spaced-apart tasks used to fire one confirmation email PER
r15 `trade_visits` row — spam for a trade with e.g. three separate
tiling visits on one project. New flow: staff propose dates on the
board, send ONE email covering every task, the trade responds per line
on a single tokened page. The r15 single-visit flow
(`BookVisitPanel.tsx`, `app/trade/[token]`) is untouched and stays the
path for one-off bookings — this round is additive.

### Migration `049_grouped_trade_booking.sql`

- **`trade_booking_requests`** (new table) — the envelope for one
  "send": `project_id`, `contact_id` (nullable, `on delete set null`,
  same discipline as `trade_visits.contact_id`), `token` (unique,
  `encode(gen_random_bytes(32), 'hex')` — same shape as
  `trade_visits.confirm_token`/`leads.brief_token`), `status`
  (`draft|sent|responded|closed` — every route in this round writes
  `'sent'` straight away; `draft`/`closed` exist for schema
  completeness only), `sent_at`, `responded_at`, `created_by`,
  `created_at`/`updated_at` (+ trigger).
- **`trade_visits` additions** — `booking_request_id` (nullable FK
  back to `trade_booking_requests`, `on delete set null`; null for
  every ordinary r15-booked visit), `suggested_start date`,
  `suggested_end date`, `response_note text` (a GROUPED line's
  trade-suggested alternative — deliberately separate columns from the
  r15 `proposed_start`/`proposed_end`/`proposed_note` trio, which
  drives a different state machine, `status = 'proposed_change'`), and
  `line_status text check (in 'proposed','accepted','date_suggested')`
  — null for every r15 visit, only set for a row linked to a
  `trade_booking_requests` row.
- **`email_sends.record_type`** CHECK widened to add
  `'trade_booking_request'` (drop+recreate constraint under its
  Postgres-default name, same pattern `046_client_invoices.sql`
  established for `'client_invoice'`). `record_id` points at
  `trade_booking_requests.id` for BOTH the grouped-request send
  (template `trade-booking-request`) and the admin "keep original +
  reply" note (template `trade-booking-reply`).

Every line of a grouped request is a REAL `trade_visits` row (not a
parallel line-items table) — the day-before reminder cron, "who else
is on site" overlap detection, and every other existing
`trade_visits`-reading feature keep working unmodified for a grouped
line, since from their point of view it's an ordinary visit with a
`start_date`/`end_date`/`status`.

### Group-mode booking panel — `components/board/GroupBookPanel.tsx`

Sibling to `BookVisitPanel.tsx` (r15), not an extension of it — a
fundamentally different flow (pick a trade FIRST, then see every one
of their tasks, vs. one phase/trade/date-range form opened from one
card). Launched from `ProjectBoard.tsx`'s existing "•••" board-actions
menu ("Group book a trade…"), disturbing zero of `BookVisitPanel`'s
own code. Picking a trade contact lists every project task
(`GET /api/projects/[id]/board`'s existing response — no new GET
route) carrying that same `contact_id`; a task is eligible (checkbox
enabled, checked by default) only when it has both `booking_date`/
`booking_end_date` AND a resolvable `phase_id` via its `board_groups`
row (a `trade_visits` row cannot exist without a `phase_id` — the
"undated tasks... excluded" rule from BUILD-SPEC.md item 2 is extended
here to also exclude "unphased"). One "Include documents" pack
(plans/schedule/SOW-trade-extract), reusing the exact same
`lib/export-presets.ts`/`lib/trade-doc-pack.ts` machinery
`BookVisitPanel` already established — frozen identically onto every
selected line's `trade_visits.document_pack` at send time.

### `POST /api/projects/[id]/trade-requests`

The panel's "Send" action. Body: `{ contact_id, task_ids, document_pack? }`.
Each `task_id` is validated independently and SKIPPED (not a
whole-request failure, reported back in the response's `skipped`
array with a reason: `no_booking_dates`/`no_phase`/`wrong_contact`/
`not_found`) rather than aborting the request — same per-row
error-collection discipline as `POST /api/phases/[id]/shift-items`. A
task already linked to an existing `trade_visits` row (booked
individually via r15) is RE-LINKED into this request rather than
creating a second, orphaned visit. Creates one `trade_booking_requests`
row (`status: 'sent'`, `sent_at: now()`), one `trade_visits` row per
eligible task (`line_status: 'proposed'`), then sends ONE email via
`lib/visit-emails.ts`'s existing `sendOrQueue()` — `email_sends` log,
7am-7pm Adelaide window, same machinery every other trigger in this
codebase reuses. Response: `CreateTradeBookingRequestResponse` —
`{ request, visit_ids, skipped, email_sent, email_skip_reason? }`.

### `GET /trade-request/[token]` — public response page

Mirrors `app/trade/[token]/page.tsx`'s patterns exactly: service-role
client (bypasses RLS — not a team session), rate-limited
(`lib/rate-limit.ts`, default 30/min), `noindex,nofollow` metadata,
mobile-first, RESLU brand (cream `#EDE8DE` / off-white `#F5F1E8` /
charcoal `#313131` / sand `#A08C72`, sharp corners, real
`/reslu-logo.png` — never typeset). Renders every non-deleted line
linked to the request (task title + date range + current state) via
`components/trade-request/TradeRequestLines.tsx`. Documents section
reuses the r15 pack-resolution logic (frozen `document_pack` choices
against the project's CURRENT live documents), proxied through this
round's own `/api/trade-request/[token]/documents/{plans,schedule,sow}`
routes (307-redirect to a representative line's own r15 `confirm_token`
proxy — `lib/trade-request.ts`'s `findRepresentativeVisitToken()` —
genuine reuse, not a parallel implementation). Expiry
(`lib/trade-request.ts`'s `isRequestFullyExpired()`) is true only once
EVERY non-deleted line has passed its own `end_date` — a request with
one line still upcoming stays live.

**MIDDLEWARE — verified, no change needed:** `lib/supabase/
middleware.ts`'s `isPublicPath` allowlist (protected, read-only this
round) already covers `/trade-request/**` and `/api/trade-request/**`
without any edit — both checks are plain string-prefix tests
(`pathname.startsWith("/trade")` / `pathname.startsWith("/api/trade")`,
not route-segment-aware), and `"/trade-request/..."` / `"/api/trade-
request/..."` both satisfy those prefixes as a side effect of sharing
the `/trade` string. Confirmed by reading that file before writing
this page — no on-machine follow-up needed, unlike the `/brief` gap
the Lead flow round above had to document.

### `POST /api/trade-request/[token]/respond`

Public, token-gated, rate-limited tighter (10/min) than the page GET.
Body: `TradeRequestRespondInput` — `{ action: 'accept', line_id }` or
`{ action: 'suggest', line_id, suggested_start, suggested_end,
response_note? }`.

- **`accept`** — `line_status -> 'accepted'`, `status -> 'confirmed'`
  (the EXISTING r15 status enum — deliberate, so every existing
  status-driven feature, e.g. the day-before reminder cron's
  `status in ('unconfirmed','tentative')` filter, treats a confirmed
  grouped line exactly like an ordinary r15 visit). Valid from
  `'proposed'` OR `'date_suggested'` (a trade can still accept the
  original date after having suggested something else). **Idempotent**
  — re-POSTing `accept` for an already-`'accepted'` line 200s with its
  current state rather than erroring (double-POST safe).
- **`suggest`** — sets `suggested_start`/`suggested_end`/
  `response_note`, `line_status -> 'date_suggested'`. Rejected (400) if
  the line is already `'accepted'` (locked). BUILD-SPEC.md item 4/5
  "Suggestions never move the board" — this action NEVER touches
  `start_date`/`end_date`/`status`, only the `suggested_*`/`line_status`
  columns, plus inserts a `daily_brief_items` attention row
  (`source: 'trade'`, `title: "{Company} suggested new dates —
  {task}"`, `link_href: /trade-requests/{id}?focus=line-{visitId}`).

After either action, if every non-deleted line on the request now has
`line_status != 'proposed'` (`lib/trade-booking.ts`'s
`allLinesResolved()`), the request itself moves to `status: 'responded'`,
`responded_at: now()` (guarded so this only fires once).

### `GET /api/trade-requests/[id]` + `components/trade-requests/TradeRequestDetail.tsx`

Authenticated admin detail view — the request envelope plus every
line, each annotated with its task title + phase name. Page:
`app/(dashboard)/trade-requests/[id]/page.tsx`, deep-linked from the
`daily_brief_items` "suggested new dates" row above and from the My
Work follow-up source below.

### `POST /api/trade-requests/[id]/lines/[visitId]/resolve`

The two admin actions on a `'date_suggested'` line (BUILD-SPEC.md item
5). Body: `{ action: 'accept_shift' }` or `{ action: 'keep_reply',
message? }`.

- **`accept_shift`** — applies `suggested_start`/`suggested_end` onto
  the line (`line_status -> 'accepted'`, `status -> 'confirmed'`,
  `confirmed_by: 'staff'`), syncs the linked `board_tasks.booking_date`/
  `booking_end_date` to match, re-runs `lib/phase-rollup.ts`'s
  `rollupPhaseDatesForGroup()`, then OFFERS (never applies) the
  EXISTING `POST /api/phases/[id]/shift-items` ripple for the rest of
  that phase's tasks via `shift_offer: { phase_id, delta_days } | null`
  in the response — this route never calls `shift-items` itself; the
  admin UI does, on a separate explicit click
  ("Shift timeline" button, `TradeRequestDetail.tsx`), reusing that
  route entirely unchanged (BUILD-SPEC.md: "do NOT reimplement ripple
  math"). `delta_days` = whole days from the line's OLD `start_date` to
  the accepted `suggested_start`, same positive-later sign convention
  `shift-items` already expects.
- **`keep_reply`** — frees the line back to `line_status: 'proposed'`
  (clears `suggested_start`/`end`/`response_note` — the original dates
  stand), optionally sends a short reply email (template
  `trade-booking-reply`, same `sendOrQueue()`/`email_sends` machinery,
  same sender). Idempotent both ways (an already-`'accepted'` or
  already-back-to-`'proposed'` line 200s without re-applying/re-sending).

Lines are independent per BUILD-SPEC.md item 5 ("Phillip confirmed
default") — accepting or resolving one line never touches any other
line's dates; the downstream phase shift is only ever offered, never
automatic, on this one explicit admin action.

### `POST /api/trade-requests/[id]/resend`

BUILD-SPEC.md item 6: "No response after 3 days -> follow-up flag...
re-send option (same token, SEQUENCE-style resend guard in
`email_sends`)." Only valid while `status = 'sent'`. Re-sends
`trade-booking-request` against the SAME unchanged `token` (no new
row, no new link minted), re-listing only lines still
`line_status = 'proposed'` (an already-accepted/date-suggested line has
nothing left to chase). Duplicate-send guard: blocks a resend if a
`'sent'` `email_sends` row for this exact `(record_type, record_id,
template)` was logged within the last 2 minutes (a rapid double-click
guard — `sendOrQueue()`'s own dedupe is keyed on `visit_datetime`,
which has no single meaning for a multi-line request, so this route
supplies its own explicit guard instead).

### My Work follow-up — `GET /api/my-work` source #11

**Genuine gap found and fixed during this round's own verification
pass:** `app/(dashboard)/trade-requests/[id]/page.tsx`'s own doc
comment already referenced "the My Work 'follow-up' source (GET
/api/my-work, source #11)" as if it existed, and
`POST /api/trade-requests/[id]/resend`'s doc comment said the same —
but no such source was actually wired into `app/api/my-work/route.ts`,
and `MyWorkItemKind` (`types/phase-12a-b.ts`) had no matching kind.
Added: one `MyWorkItem` per `trade_booking_requests` row still
`status = 'sent'` whose `sent_at` is more than 3 whole days ago
(`lib/trade-booking.ts`'s `isBookingRequestFollowupDue()` — the exact
same helper `POST .../resend`'s own guard uses, so both agree on
"due"). `due` is set to `sent_at`'s date, which is always in the past
by construction here, so this always lands in the "overdue" bucket
(same as an overdue lead follow-up). `href` deep-links to the admin
request detail page, which carries the real "Resend request" button —
this source only surfaces the flag, per every other My Work source's
"deep link to where the action lives" convention. Team-visible, not
admin-gated (scheduling data, not financial). Required a matching
addition to `MyWorkItemKind` (additive union member) and to
`components/my-work/MyWorkWorkspace.tsx`'s `KIND_LABEL` — that `Record`
is exhaustive over `MyWorkItemKind`, so skipping it would have been a
genuine TS2741 build error, the exact class of bug that file's own
comment already documents happening once before (`ordering_due`, Order-
by engine round).

### Sender identity

The grouped-request/reply emails go out via `lib/visit-emails.ts`'s
`sendOrQueue()`/Resend, sender `'Aria — RESLU <aria@reslu.com.au>'`
(`RESEND_FROM`, unchanged, shared with the lead/client_event paths).
The r15 single-visit trade confirmation email (`POST
/api/board-tasks/[id]/book-visit`) sends via a DIFFERENT transport —
`lib/gmail/send.ts`'s `sendTeamEmail()`, sender `'RESLU
<aria@reslu.com.au>'`. **Same underlying mailbox address
(`aria@reslu.com.au`) either way** — only the transport (Resend HTML
vs. Gmail plain-text) and the FROM display-name string differ
cosmetically (`'Aria — RESLU <...>'` vs `'RESLU <...>'`). Reusing
`sendOrQueue()` (per this round's own build instruction: "via existing
visit-emails machinery — sendOrQueue, email_sends log, Adelaide
window") was judged to satisfy "match the existing trade sender" in
substance — a recipient sees the same sending address either way — 
without forking `RESEND_FROM` per-record-type, which would have meant
either a breaking signature change to a function three other rounds'
trigger sites already call, or a second near-duplicate send function.
Flagged here explicitly rather than silently assumed correct.

### `lib/trade-booking.ts` (new, pure helpers)

`isBookingRequestFollowupDue()`, `allLinesResolved()`,
`formatTaskLineDateRange()`, `buildTaskRowsHtml()`,
`computeShiftDeltaDays()`, `diffDays()` — plain data-in/data-out, no
Supabase/Next imports, mirroring `lib/trade-visits.ts`'s own shape.

**Files touched:** `supabase/migrations/049_grouped_trade_booking.sql`
(new, only migration this round), `types/round-grouped-trade-booking.ts`
(new), `lib/trade-booking.ts` (new), `lib/trade-request.ts` (new),
`lib/visit-emails.ts` (additive — `trade-booking-request`/
`trade-booking-reply` added to `TEMPLATE_FILES`, `VisitEmailMergeData`/
`merge()` gain `company`/`project_name`/`project_address`/`task_rows`/
`request_link`/`attachments_note`/`message`; nothing existing changed),
`types/visit-emails.ts` (`VisitEmailRecordType` gains
`'trade_booking_request'`, `VisitEmailTemplateName` gains the two new
template names, `VisitEmailDetail` gains the matching fields —
additive), `emails/trade-booking-request.html` (new),
`emails/trade-booking-reply.html` (new), `emails/README.md` (new
section), `components/board/GroupBookPanel.tsx` (new),
`components/board/ProjectBoard.tsx` ("Group book a trade…" menu item +
panel mount, additive), `components/trade-request/TradeRequestLines.tsx`
(new), `components/trade-requests/TradeRequestDetail.tsx` (new),
`app/trade-request/[token]/page.tsx` (new),
`app/api/trade-request/[token]/respond/route.ts` (new),
`app/api/trade-request/[token]/documents/{plans,schedule,sow}/route.ts`
(new), `app/api/projects/[id]/trade-requests/route.ts` (new),
`app/api/trade-requests/[id]/route.ts` (new),
`app/api/trade-requests/[id]/resend/route.ts` (new),
`app/api/trade-requests/[id]/lines/[visitId]/resolve/route.ts` (new),
`app/(dashboard)/trade-requests/[id]/page.tsx` (new),
`app/api/my-work/route.ts` (source #11, additive — added during this
round's own verification pass, see that section above),
`types/phase-12a-b.ts` (`MyWorkItemKind` gains `trade_booking_followup`,
additive), `components/my-work/MyWorkWorkspace.tsx` (`KIND_LABEL` gains
the matching entry, additive), `next.config.ts`
(`outputFileTracingIncludes` gains the three new routes that call
`sendOrQueue()`, same tracing-gap pattern as every other entry there),
`docs/API.md` (this section). Single migration (049); no protected
file touched — `lib/supabase/middleware.ts`, `vercel.json`,
`components/items/SpecRegister.tsx`/`RoomAssignBar.tsx`/
`RoomBuilder.tsx`/`ItemRoomsEditor.tsx`, `lib/csv.ts`,
`app/api/projects/[id]/import/**`, `types/index.ts`, every Second
Brain/invoicing(046)/CPD(047)/lead-flow(048) file, and every other file
on this round's protected list were read for context (several — board
route, r15 trade-visit files, shift-items, daily_brief_items shape,
visit-emails, export-presets — were read specifically to match
existing conventions) but never edited. `lib/visit-emails.ts` was
extended additively only, per this round's explicit allowance —
the lead-flow round's sender/48h/ICS work is untouched (confirmed by
diff-reading that file's lead-flow-era sections before adding to them).

## Fee proposal phase (11 July 2026, migration 051)

BUILD-SPEC.md §"Fee proposal phase (r23)": "ONE signable document:
proposal + terms merged (replaces LawDepot service contract). Client
signs on the tokened page → signed PDF stored + emailed → deposit
invoice auto-DRAFTED (never auto-sent) via 046 machinery → attention
item." Content source of truth: `docs/proposal-reference-content.md`.

### Migration `051_proposals.sql`

`proposals` (id, lead_id FK null, project_id FK null — at least one set
via `chk_proposals_lead_or_project`, token unique default 32-byte hex,
status draft|sent|accepted|closed, content jsonb, total_inc numeric,
deposit_inc numeric, viewed_at, sent_at, signed_name, signed_at,
signature jsonb, signed_pdf_path, created_at, updated_at) — column list
exactly per BUILD-SPEC.md item 1. `content` is one flat jsonb document
(`types/proposals.ts`'s `ProposalContent`: letter, vision,
scope_sections[], fees{}, timeline[], exclusions{}, terms_md) — no
sub-table per section/stage/milestone/row, unlike a SOW's own
normalised sections/lines, since nothing else in this schema needs to
query into a single scope bullet or fee milestone relationally.
`total_inc`/`deposit_inc` are numeric(12,2) dollars, INC GST — matches
the existing `client_invoices` numeric convention (not cents-as-
integer). No new storage bucket: signed PDFs reuse the existing private
`assets` bucket (009/010) at `proposals/{id}/{timestamp}-signed.pdf`
(`lib/proposals.ts`'s `proposalPdfPath()`) — the same "one immutable
generated PDF per record, private, signed-URL-only access" shape every
other generated PDF in this schema already uses. Same drop+recreate-
under-default-name CHECK-widening technique 046/049 already used on
`email_sends.record_type` (now also allows `'proposal'`), applied here
to two MORE columns this round doesn't own: `aria_queue.kind` (now
allows `'draft_proposal'`, owned by 033) and `daily_brief_items.source`
(now allows `'proposal'`, owned by 041) — no row in either table's
owning migration is touched, only the CHECK constraint from outside it.

### `lib/proposal-templates.ts` — three seed templates + default terms

`proposalTemplateContent(kind)` returns a fresh `ProposalContent` for
`'renovation'` (Alley, Glenelg North — percentage-form fee, single
"Design Fee" stage), `'new_build'` (Greenwith — percentage-form fee,
single stage), or `'multi_phase'` (Neave, canonical — three
dollar-form stages, one per phase) — copied verbatim into a new
proposal's `content` column by `POST /api/proposals`, then ordinary
freely-editable data from that point on, same "seed as templates" shape
`lib/sow-templates.ts` already established. Every fee milestone/stage
amount ships at `0` — the reference doc's real historical dollar
figures are structure guidance, not placeholder pricing to ship on a
new proposal. `DEFAULT_TERMS_MD` carries the RESLU custom clauses
(Media & Content Usage, Value Management & Cost Alignment, Additional
Services) plus the Hone-contract core boilerplate, verbatim per
`docs/proposal-reference-content.md`'s "Default terms" section,
rendered as plain ALL-CAPS-heading/blank-line-separated paragraphs
(no markdown renderer exists in this repo, and this round adds none —
see that file's own header comment). Letter/vision ship with Neave-
style EXAMPLE prose (not lorem), `{{double-brace}}` tokens marking the
genuinely per-client specifics — no server-side template-engine
substitution happens; an admin (or Aria, via `set_proposal_draft`)
edits the text directly.

### `lib/proposals.ts` — shared helpers

`computeProposalTotal(fees)` — server-computed `total_inc`, sum of
every fee stage's own `total_inc`, never accepted verbatim from the
client (same posture as `client_invoices`' stored totals). `sumStageMilestones(stage)` —
Builder-UI convenience (not DB-enforced) for auto-summing a stage's
milestones into its own total on blur. `defaultDepositInc(totalInc)` —
`round(30% of total_inc)` to the nearest whole DOLLAR (`Math.round`, not
cents-rounding) at proposal-create time only; a later manual override
sticks (content edits never re-force it back to 30%). `depositExGst(depositInc)` —
`deposit_inc / 1.1`, rounded half-up to cents, the ex-GST figure fed
into `lib/client-invoices.ts`'s `computeTotals()` when drafting the
deposit invoice. `isProposalFollowupDue(proposal, now?)` — `status='sent'`
and `sent_at` more than 5 whole days ago; drives the My Work follow-up
source #12 below. `proposalPdfPath(id, now?)` — see migration section
above. `residenceLabel({lead, project})` / `recipientEmail({lead, project})` —
shared resolution precedence (`project.alias` → `project.name` →
`lead.surname_project` → `"your project"`; `project.client_email` →
`lead.email` → `null`) used by every route that needs a display name or
send-to address for a proposal.

### `POST /api/proposals` / `GET /api/proposals`

Admin-only (fee proposals carry design-fee/pricing data). `POST` body:
`{ lead_id?, project_id?, template }` — at least one of lead_id/
project_id required. Seeds `content` from `proposalTemplateContent()`,
computes `total_inc`/`deposit_inc` (both land at 0 until the admin
fills in real numbers), starts `status='draft'`. **Aria pre-draft**
(item 5): when `lead_id` is set AND that lead has `brief_answers`,
inserts one `aria_queue` row (`kind: 'draft_proposal'`, `dedupe_key: 'draft_proposal:{proposal_id}'`,
`payload: { proposal_id, lead_id }`) — Aria drafts
`content.letter`/`content.vision` via `set_proposal_draft`, Phillip
always reviews before Send. `GET` lists by `?lead_id=` or `?project_id=`,
newest first.

### `GET` / `PATCH /api/proposals/[id]`

Admin-only. `GET` — full row (also the MCP `get_proposal` tool's fetch
target — Aria authenticates as a real admin user, same gate covers
her). `PATCH` body: `PatchProposalInput` — `{ content?, deposit_inc? }`
— the Builder UI's own **draft-commit-on-blur** save target
(`components/proposals/ProposalEditor.tsx`), always sending the WHOLE
`content` object on blur, never per-keystroke (this codebase "was
burned before" on per-keystroke PATCH — see that component's own
header comment). `total_inc` is always server-recomputed from
`content.fees` when `content` is provided; `deposit_inc`, when
provided, is stored as-is. Blocked (409) once `status` is `'accepted'`
or `'closed'` — freely editable while `'draft'` or `'sent'`.

### `PATCH /api/proposals/[id]/draft` — Aria's `set_proposal_draft` target

Deliberately narrower than the general PATCH above — body:
`{ letter?, vision? }`, at least one required, merged into `content`
(every other field untouched, `total_inc` never recomputed). Enforces
BOTH of item 5's restrictions server-side (not just by MCP-tool
description discipline): 409 if `status !== 'draft'`, and only
`letter`/`vision` can ever be written by this route regardless of what
else might be in the body.

### `POST /api/proposals/[id]/send`

Admin-only, `status` must be `'draft'` (409 otherwise — use `.../resend`
for an already-sent proposal). Requires a recipient email
(`lib/proposals.ts`'s `recipientEmail()`); the token is NOT rotated
(migration 051 mints it once, at row-create time, so the Builder UI's
"Live preview" link stays stable and usable even before Send). Flips
`status='sent'` + stamps `sent_at` BEFORE attempting the email send
(same "the envelope is sent" convention as the grouped-trade-booking
send route, 049) — a queued-outside-window or failed Resend call still
starts the >5-day follow-up clock. Sends via `lib/proposal-emails.ts`'s
own `sendProposalEmail()` (see `emails/README.md`'s "`proposal-sent.html`"
section for why this is a separate, small re-implementation rather than
extending `lib/visit-emails.ts`'s own private template/record-type
unions) — sender `'Aria — RESLU <aria@reslu.com.au>'`, `email_sends`
logged (`record_type='proposal'`, `template='proposal-sent'`), 7am-7pm
Adelaide window respected. Email body: branded button link to
`https://spec.reslu.com.au/proposal/{token}` (`{{request_link}}`), no
attachment.

### `POST /api/proposals/[id]/resend`

Admin-only, `status` must be `'sent'`. Same token/link as the original
send; does NOT touch `sent_at` (the follow-up clock keeps counting from
the ORIGINAL send). Dupe guard: a simple 60-second window against the
latest `email_sends` "proposal-sent" row for this proposal (a
SELECT-then-guard, not the atomic claim-function shape
`trade_booking_requests`' resend has — migration 051's own column list,
followed exactly per item 1, has no `last_resend_at` column to back
that shape; documented as a smaller, deliberately-accepted race window
for this rare, manual admin action).

### `GET /proposal/[token]` — public client-facing document + sign

Public, token-gated, rate-limited, noindex, mobile-first, real logo —
same trust model as `/trade-request/[token]`/`/brief/[token]` (this
round's own "study first" list). Renders the FULL document: letter,
vision, scope sections (bullets + `→` deliverables), design fee +
payment structure (auto-summed stage totals, grand total, deposit),
project timeline (+ the fixed "Council assessment timeframes..."
caveat line, `lib/proposal-templates.ts`'s `TIMELINE_COUNCIL_CAVEAT`,
always appended by the renderer — never stored per-row), exclusions +
allowance, terms (`<details>` collapsible, plain preformatted
paragraphs — no markdown renderer added). `viewed_at` is set ONCE, only
while `status='sent'` and only if still null — a draft-status "Live
preview" visit from the Builder UI never sets it, and a later revisit
never re-sets it. Sign-to-accept section renders `ProposalSignForm`
(reuses `components/portal/SignatureCanvas.tsx`'s own plain-`<canvas>`
draw capture) only while `status='sent'`; shows a "signed by ... on ..."
summary once `accepted`, or a plain notice for `draft`/`closed`.

### `POST /api/proposal/[token]/accept`

Public, token-gated, rate-limited. Body: `AcceptProposalInput` —
`{ drawn_data_url, typed_name, consent }` — ALL three required (unlike
the pre-existing e-signature machinery's "draw AND/OR type": this
round's own migration 051 column comment captures both
unconditionally, simpler for a document with only the one accept
action). **Idempotent / double-POST safe**: the actual status flip is a
CONDITIONAL update (`.eq("status", "sent")`) — of any two concurrent or
retried POSTs, only one can ever win it; the other (and any later
re-POST once `status='accepted'`) gets the SAME `{ ok: true, status:
'accepted', already_accepted: true }` response, never a duplicate
write. Only the winning request proceeds to: render+store the signed
`ProposalPdf` (private `assets` bucket), draft the deposit invoice via
`lib/client-invoices.ts`'s own `cleanLineItems`/`computeTotals`/
`nextInvoiceNumber` (line `"Design fee deposit — {residence}"`, amount
`depositExGst(deposit_inc)` ex-GST — status stays `'draft'`, NEVER
auto-sent), email the signed PDF to the client + `phillip@reslu.com.au`
(inline HTML body, no template file — see `emails/README.md`), and
insert a dedupe-guarded `daily_brief_items` row (`source='proposal'`,
same "existing open row" guard shape as `POST /api/brief-submit/[token]`'s
own insert). All four of those are wrapped so a failure is reported
(`lib/report-error.ts`) but never turns an already-recorded signature
into an error response — same "the evidence row is the real record;
everything after it is best-effort" posture as
`app/api/portal/[token]/sign/[requestId]/route.ts`'s own certificate/
email step. **Known, documented gap**: because each of those four steps
runs at most once (only inside the single winning request), a failure
partway through (e.g. the deposit-invoice insert fails after the PDF
already stored) is NOT automatically retried on a later re-POST — that
re-POST just sees `status='accepted'` and short-circuits. This matches
the existing signature route's own risk tolerance exactly rather than
inventing a new repair-on-retry mechanism; a stuck proposal is visible
via `lib/report-error.ts`'s admin Settings "System health" surface.

### `components/pdf/ProposalPdf.tsx`

Cover (logo, `"{CLIENT} | DESIGN PROPOSAL"`, residence, date) → body
page(s) (letter, vision, scope, fees, timeline, exclusions, terms) →
signature page (drawn PNG or typed name, signed date, IP; RESLU's own
block reads "Countersigned by issuance of this proposal" — no live
counter-signature flow exists). Same font/logo `Font.register`
duplication + brand-palette-constant convention as
`InvoicePdf.tsx`/`SowPdf.tsx` (deliberate — each PDF module owns its
own module-scope font state). **Pagination**: per `SowPdf.tsx`'s own
documented "overlapping text" lesson, NO section is `wrap={false}` —
only short atomic rows (a bullet, a milestone line, a timeline row) are,
and every section heading carries `minPresenceAhead` so it's never
orphaned alone at the bottom of a page.

### My Work follow-up — `GET /api/my-work` source #12

Mirrors source #11 (`trade_booking_followup`, 049) exactly in shape,
admin-gated like source #2/#9 (financial-adjacent, unlike source #11's
booking dates): a `proposals` row still `status='sent'` whose `sent_at`
is more than 5 whole days ago and not yet accepted
(`lib/proposals.ts`'s `isProposalFollowupDue()`). `types/phase-12a-b.ts`'s
`MyWorkItemKind` gains `'proposal_followup'` (additive);
`components/my-work/MyWorkWorkspace.tsx`'s `KIND_LABEL` gains the
matching entry — the SAME exhaustive-`Record` gotcha the `ordering_due`
bug-fix comment already documents ("missing the label entry is a real
TS2741 build error") applied proactively this round rather than fixed
after the fact. `href` points at the new `/proposals/{id}` editor,
where the existing `POST /api/proposals/[id]/resend` action lives
(item 6's "re-send option (same token, email_sends dupe guard)" — see
that route's own section above; no separate resend route was needed).

### Builder UI — `components/proposals/{ProposalsSection,ProposalEditor}.tsx`

`ProposalsSection` (list + "New proposal" template-picker composer) is
ONE shared component mounted from BOTH
`components/leads/LeadDetailPanel.tsx` (`leadId` prop, new "Fee
proposal" section) and `app/(dashboard)/projects/[id]/invoices/page.tsx`
(`projectId` prop, new "Fee proposals" section above the existing
Client/Supplier invoice sections) — exactly one prop set per caller,
mirroring `proposals.lead_id`/`project_id`'s own "at least one" shape.
`ProposalEditor` is the full section editor, mounted at the dedicated
`app/(dashboard)/proposals/[id]` route (a full page, not a slide-over
panel — chosen over `components/leads/LeadDetailPanel.tsx`'s panel
pattern because a proposal's content is far more than a panel
comfortably holds, the same reasoning the SOW/estimate editors already
apply to their own content-heavy pages) — **draft-commit-on-blur**,
mirroring `LeadDetailPanel.tsx`'s own single-save `draft`/`dirty`/
blur-commits pattern (the whole `content` object PATCHes on blur, never
per-keystroke), NOT `SowBuilder.tsx`'s per-ROW save (a proposal's
content has no sub-row ids to PATCH independently — see migration 051's
own table comment). Section add/remove/reorder uses plain ↑/↓ move
buttons (no drag-and-drop library added).

### Middleware — exact allowlist lines for Claude Code

`lib/supabase/middleware.ts` is protected/out of this round's edit
boundary (confirmed by reading it before writing any route — no
existing `isPublicPath` prefix covers `/proposal` or `/api/proposal`;
in particular a BARE `pathname.startsWith("/proposal")` would ALSO
incorrectly match the admin-only `/proposals/[id]` editor route, and a
bare `pathname.startsWith("/api/proposal")` would ALSO match the
admin-only `/api/proposals` CRUD API — both are boundary-sensitive the
same way the grouped-trade-booking round's own `/trade` vs.
`/trade-request` fix already documents). Add, boundary-aware, alongside
the existing `/brief`/`/trade-request` lines in `isPublicPath`:

```ts
pathname === "/proposal" ||
pathname.startsWith("/proposal/") ||
pathname.startsWith("/api/proposal/") ||
```

Without these two lines, `/proposal/[token]` and
`/api/proposal/[token]/accept` both redirect to `/login` (or 401) before
they ever run — both routes are fully built and correct otherwise. See
`README.md`'s "Fee proposal phase" section for the full install-step
writeup.

**Files touched:** `supabase/migrations/051_proposals.sql` (new, only
migration this round), `types/proposals.ts` (new),
`lib/proposals.ts`/`lib/proposal-templates.ts`/`lib/proposal-emails.ts`
(new), `components/pdf/ProposalPdf.tsx` (new),
`components/proposal/ProposalSignForm.tsx` (new),
`components/proposals/{ProposalsSection,ProposalEditor}.tsx` (new),
`app/api/proposals/route.ts` + `[id]/{route,draft/route,send/route,resend/route}.ts`
(new), `app/api/proposal/[token]/accept/route.ts` (new),
`app/proposal/[token]/page.tsx` (new),
`app/(dashboard)/proposals/[id]/page.tsx` (new), `emails/proposal-sent.html`
(new), `emails/README.md` (additive section), `docs/ARIA.md` (additive
"Fee proposal drafting" section), `docs/API.md` (this section),
`mcp/src/index.mjs` (additive — `get_proposal`/`set_proposal_draft`
tools), `types/phase-12a-b.ts` (`MyWorkItemKind` gains
`proposal_followup`, additive), `components/my-work/MyWorkWorkspace.tsx`
(`KIND_LABEL` gains the matching entry, additive), `app/api/my-work/route.ts`
(source #12, additive), `components/leads/LeadDetailPanel.tsx`
("Fee proposal" section, additive), `app/(dashboard)/projects/[id]/invoices/page.tsx`
("Fee proposals" section, additive), `next.config.ts`
(`outputFileTracingIncludes` gains three new entries — the two send/
resend routes' `emails/**` read and the accept route's PDF font/logo
read — same tracing-gap pattern as every other entry there). Single
migration (051); no protected file touched — `lib/supabase/middleware.ts`,
`vercel.json`, `app/api/digest/**`, `components/items/SpecRegister.tsx`/
`RoomAssignBar.tsx`/`RoomBuilder.tsx`/`ItemRoomsEditor.tsx`, `lib/csv.ts`,
`app/api/projects/[id]/import/**`, `types/index.ts`, every Second Brain
migration/route/lib file, `lib/signatures.ts` (read for its
`decodePngDataUrl()`/`SIGNATURE_CONSENT_STATEMENT` exports and its own
route's certificate/email posture, never edited), `lib/client-invoices.ts`
(read for its exact insert shape, never edited), and `app/brief/[token]`/
`app/trade-request/[token]`/`app/trade/[token]` (read for pattern only)
were all read for context but never edited.
