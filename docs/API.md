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
Auth: session. Body: none. Query: `?revision=`, `?subtitle=`. Response:
raw PDF binary (`Content-Disposition: inline`, `Cache-Control: no-store`).
Uses an explicit `PDF_ITEM_FIELDS` whitelist that excludes all
pricing/ordering columns — the builder-facing PDF never contains
financial data regardless of caller role. Items filtered to
non-deleted, ordered category then item_code.

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
**Aria-relevant** (`list_contacts` MCP tool).

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
is filtered). Response: `{ leads: Lead[] }` or `{ leads, summary }`.
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
