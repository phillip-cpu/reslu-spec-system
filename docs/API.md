# RESLU Spec System — API reference

This is the agent-integration contract for the RESLU Spec System's REST
API (`app/api/**`). BUILD-SPEC.md "Agent control — Aria" (Phase 1):
Aria authenticates as a normal Supabase user (`aria@reslu.com.au`,
email/password → JWT) and drives the product entirely through these
routes — every UI capability has (or should have) a route here. Routes
tagged **Aria-relevant** are the ones she's expected to call most:
items CRUD/import, invoices POST/PATCH/approve, estimate reads.

Written by walking every file under `app/api/**` in this working copy
(Week 6). Kept accurate to the code as it stands — if a route changes,
update this file in the same commit.

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
Auth: session. Body: none. Query: `?revision=`, `?subtitle=`. Response:
raw PDF binary (`Content-Disposition: inline`, `Cache-Control: no-store`).
Uses an explicit `PDF_ITEM_FIELDS` whitelist that excludes all
pricing/ordering columns — the builder-facing PDF never contains
financial data regardless of caller role. Items filtered to
non-deleted, ordered category then item_code.

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
delivered_at`. `price_trade`/`markup_pct` are silently dropped from a
non-admin body (not rejected). `item_code` is immutable. Response:
`{ item }` (stripped for non-admins). Side effect: when `status`
transitions to `"Ordered"` and no `monday_item_id` exists yet, fires a
one-way Monday sync via `after()` — fire-and-forget, never blocks or
fails the response; on failure nothing is written back (a later status
change or `POST /api/monday/sync/[itemId]` can retry). **Aria-relevant.**

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
`usage_count desc, name asc`, capped at 200. `FINANCIAL_FIELDS =
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

### POST /api/digest/flush
Auth: session (not admin-gated) **or** header
`authorization: Bearer ${CRON_SECRET}` (Week 7). Body: none. Response:
passthrough of `flushDigest()`'s result. Sends any pending
`portal_digest_queue` rows, grouped per project, to admin profiles,
then marks them `sent_at`. `vercel.json` now schedules this hourly via
Vercel Cron (`"0 * * * *"`); the manual/session-authenticated trigger
(e.g. a "Send digest" button) keeps working unchanged. The cron path
uses a service-role Supabase client (no user session exists on a
scheduled call) — see the route's doc comment for the reasoning.

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
