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
Auth: session. Body: `{ name, client_name, address?, monday_board_id?, budget? }`.
Response: `{ project }` (201). `client_token` is DB-generated, never
accepted from the request. **Aria-relevant.**

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
`?q=`, `?category=`. Response: `{ items }`, ordered
`usage_count desc, name asc`, capped at 200 (Phase 14A: `?limit=`
override, max 1000; `?offset=` for paging; response also carries
`total` (exact count), `limit`, `offset`). `FINANCIAL_FIELDS =
["price_trade", "trade_price_received_at", "trade_price_source"]`
stripped for non-admins; `price_rrp` is NOT gated (public reference
price). **Aria-relevant.**

### POST /api/library
Auth: session (financial fields admin-only). Body: `{ name, category
(required), description?, supplier?, supplier_email?, brand?, colour?,
material?, finish?, width_mm?, height_mm?, length_mm?, depth_mm?,
product_url?, default_image_url?, price_rrp?, price_trade?,
trade_price_source?, trade_price_received_at? }`. Response: `{ item }`
(201, stripped for non-admins). A non-admin's financial fields are
silently forced to null rather than rejected. Setting `price_trade`
auto-stamps `trade_price_received_at` to today if not supplied.
`product_url_normalized` computed server-side.

### PATCH /api/library/[id]
Auth: session (financial fields admin-only). Body: any of the
editable fields listed under POST above. Response: `{ item }`
(stripped for non-admins). Non-admin financial-field keys in the body
are silently ignored (not rejected).

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

### POST /api/leads/[id]/create-project
Auth: admin. Body: none. BUILD-SPEC.md: "Moving a lead to Design Work
In Progress offers one-click 'Create project' (links lead -> project)."
**Phase 11 extension (5 July 2026):** UI label renamed **"Progress to
job"** in `components/leads/LeadDetailPanel.tsx` — this route path is
unchanged. The button is now surfaced whenever the lead's stage is
`'Design Work In Progress'`, `'Construction In Progress'`, or
`'Complete'` (previously only right after a stage change into 'Design
Work In Progress'), so older leads already further along can still be
progressed to a job.

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

**On-machine follow-up required:** `/trade` and `/api/trade` are not
yet in `lib/supabase/middleware.ts`'s `isPublicPath` allowlist — until
a human adds them, an unauthenticated visitor hitting this page gets
redirected to `/login`. See this feature's build notes for the exact
lines to add (that file is read-only for this agent).

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
`computeInsuranceStatus()` from the contact's non-deleted
`contact_documents` — only `public_liability`/`workers_comp` kinds
count; `missing` is only ever returned for a trade-category contact,
per `lib/insurance.ts`'s `TRADE_CATEGORIES` allow-list) and, on the
list route only, `document_count`. `components/contacts/ContactsBrowser.tsx`
shows a status badge per contact (suppressed for a non-trade contact
with zero documents — nothing to flag) and an expandable
`ContactDocumentsPanel` (upload/list/delete, editable expiry date,
re-fetches the single-contact route after any change to refresh the
badge without re-fetching the whole list).

### GET /api/contacts/attention
Auth: session. Response: `InsuranceAttentionGroups` — `{ expired,
expiring, missing }`, each an array of trade-category contacts in that
insurance state (`lib/insurance.ts`'s `computeInsuranceAttention()`).
Mirrors `GET /api/leads/attention` / `GET /api/visits/attention`'s
existing pattern; also folded additively into `GET /api/my-work`'s
combined feed as `insurance_expiring` items.

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
