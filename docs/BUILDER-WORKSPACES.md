# Builder workspaces

RESLU projects remain `/`. Builder-owned jobs appear in `/builders/harvard-homes` and remain accessible at their existing project URLs. The authenticated team boundary is unchanged; no portal permissions were added.

Builder standards reference `library_items.id` through `builder_library_selections`. A reference is not a standard. New standards are proposed; job use does not create or approve them.

Cara is one project with `settings.builder_workspace.lots` for Lot 58/59. Existing items default to shared. `/projects/:id/schedule` resolves shared plus lot-specific rows; an explicit matching `selection_key` replaces only that slot for the lot. Existing FF&E, portal, and PDF routes are retained. Lot filtering is an internal workspace; client presentation/export changes are not implied.

## Library-first product workflow

1. Search `/api/library?q=...` and `/api/library/check` by brand/model/finish and product URL before creating anything. Resolve ambiguous model references before import.
2. Create or enrich the existing canonical library product through `/api/library` and `/api/library/:id`. No preview products are seeded.
3. Upload verified binaries once through `POST /api/library/:id/documents`: prepare with `{action:"prepare",kind,url,label,filename,mime_type,size_bytes,sha256,version_note?,verified_on?,verification?}`, upload bytes using the returned scoped path/token to the existing private assets bucket, then send the same metadata with `{action:"finalize",storage_path}`. Server verifies MIME signatures, size and SHA-256. Maximum 25 MiB; direct storage transfer supports manuals larger than Vercel request-body limits. Sources are retained alongside stored bytes. Product-scoped authenticated download URLs mint fresh short-lived signed reads. The product details page `/library/:id` shows all revisions, preserving earlier model applicability. Existing `spec_sheet_url` / `install_manual_url` references remain visible. Documents are shared product data, never copied per job.
4. Associate the canonical product using `POST /api/projects/:id/schedule` with `{library_item_id}`. It starts as a shared unconfirmed `projects.settings.builder_workspace.candidates` relationship. There is no quantity or price column, no item row, and no zero sentinel. Existing totals, procurement, order lists, and exports read `items`, so candidates are excluded by construction. Duplicate project use is surfaced rather than silently copied. This action does not update standards.
5. Assign scope or override slot with `PATCH /api/projects/:id/schedule`: `{item_id, selection_scope: "shared" | "lot58" | "lot59", selection_key: string | null}`. The item must belong to that project. For a candidate pass `is_candidate:true`; the same scope checks apply. Product variants should use distinct canonical library records; document revisions append and do not silently replace a product variant or approval.

Template application uses `PATCH /api/builders/:slug` with `{project_id, template_name}` and updates only the template structure under the builder workspace settings using an optimistic timestamp check. It creates no products or approvals.

## Validation

`node --experimental-strip-types --test lib/builder-workspaces.test.ts`

`supabase/tests/builder_workspace_contract.sql` runs in a rollback transaction. It verifies grants/RLS, append-only documents, two jobs sharing one product's two document revisions, and unapproved/unconfirmed-quantity association. No fixture records survive.

## Binary upload and candidate release

Migration `20261021075202_library_binary_documents_and_candidates.sql` is required before deploying the corrected code. It adds metadata and append-only binary content identity to library documents while candidates use existing project settings and RLS, with optimistic concurrency checks. It does not create buckets or change storage policies. No new candidate-table grants or storage permissions are introduced. No candidate is automatically promoted to a costable item or client approval. Historical price columns are untouched.

## Preliminary allocations and opt-in schedule exports

Candidates may now carry `preliminary_allocations` in their existing project settings relationship. Each allocation has `room`, optional verified `room_id` and `lot_key`, `quantity` (number or null), `unit` (text or null), `lot_basis` (`per_lot`, `project_total`, or `unknown`), and `status: preliminary`. Optional bounded fields retain `quantity_basis`, `source_reference`, `source_revision`, and `note`. Known quantities require a unit and known lot basis. No new migration is needed for these fields.

Allocation-only PATCH requests preserve scope/key; scope-only edits preserve allocations and stored source metadata. Explicit allocation lots must exist and match a lot-specific selection. `shared_internal` remains supported as an existing shared scope. Explicit lot evidence is displayed only for that lot or the all-selections organiser; counts are never multiplied across lots.

The schedule reuses `RoomBuilder` and `ExportDialog`. Existing room records are managed through the existing room APIs; suggested room names can be selected in the preliminary editor. This code does not seed Cara rooms or apply audit quantities. Group by room/type continues to show one canonical candidate row in the interactive view.

The existing PDF endpoint accepts an opt-in builder view: `/api/projects/:id/pdf?schedule=builder&scope=lot59&grouping=room&docs=1`. Without `schedule=builder`, existing register exports remain unchanged. The builder export applies scope and category filters before loading documents, renders each preliminary room allocation as an explicitly labelled row, and never creates items, writes image/cache records, or changes totals. It reuses `SchedulePdf` and the existing bundle renderer. Stored canonical product documents are included once per stored path; source-link-only or missing documents are reported in the documents index. `docs=1` is optional. Unknown quantities stay TBC, including in the PDF.

Normal schedule prose is reduced for presentation only: hashes, bucket URLs and import audit paragraphs are hidden while useful product restrictions and outstanding issues remain. Source metadata remains stored and available for audit. Raw verification fields are not added to exports.

Additional local checks:
- `node --experimental-strip-types --test lib/candidate-allocations.test.ts lib/schedule-product-notes.test.ts lib/schedule-grouping.test.ts`
- `node scripts/test-candidate-allocations.mjs`
- `node scripts/test-builder-schedule-export.mjs` (synthetic local PDFs only; no network or database writes)
- `npm run build -- --webpack` when using an out-of-root dependency symlink, as documented in `docs/revisions/LOCAL-REVIEW.md`.
