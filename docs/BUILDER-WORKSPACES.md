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
