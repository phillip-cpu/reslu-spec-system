# Builder workspaces

RESLU projects remain `/`. Builder-owned jobs appear in `/builders/harvard-homes` and remain accessible at their existing project URLs. The authenticated team boundary is unchanged; no portal permissions were added.

Builder standards reference `library_items.id` through `builder_library_selections`. A reference is not a standard. New standards are proposed; job use does not create or approve them.

Cara is one project with `settings.builder_workspace.lots` for Lot 58/59. Existing items default to shared. `/projects/:id/schedule` resolves shared plus lot-specific rows; an explicit matching `selection_key` replaces only that slot for the lot. Existing FF&E, portal, and PDF routes are retained. Lot filtering is an internal workspace; client presentation/export changes are not implied.

## Library-first product workflow

1. Search `/api/library?q=...` and `/api/library/check` by brand/model/finish and product URL before creating anything. Resolve ambiguous model references before import.
2. Create or enrich the existing canonical library product through `/api/library` and `/api/library/:id`. No preview products are seeded.
3. Append verified references with `POST /api/library/:id/documents`: `{kind: "spec_sheet" | "install_manual" | "technical_drawing", url: "https://...", label, version_note?}`. The product details page `/library/:id` shows all revisions, preserving earlier model applicability. Existing `spec_sheet_url` / `install_manual_url` references remain visible. Documents are shared product data, never copied per job.
4. Associate the canonical product using `POST /api/projects/:id/schedule` with `{library_item_id}`. It starts shared, client-unapproved, and quantity to confirm (0 placeholder plus explicit application note; existing schema requires a number). Duplicate project use is surfaced rather than silently copied. This action does not update standards.
5. Assign scope or override slot with `PATCH /api/projects/:id/schedule`: `{item_id, selection_scope: "shared" | "lot58" | "lot59", selection_key: string | null}`. The item must belong to that project. Product variants should use distinct canonical library records; document revisions append and do not silently replace a product variant or approval.

Template application uses `PATCH /api/builders/:slug` with `{project_id, template_name}` and updates only the template structure under the builder workspace settings using an optimistic timestamp check. It creates no products or approvals.

## Validation

`node --experimental-strip-types --test lib/builder-workspaces.test.ts`

`supabase/tests/builder_workspace_contract.sql` runs in a rollback transaction. It verifies grants/RLS, append-only documents, two jobs sharing one product's two document revisions, and unapproved/unconfirmed-quantity association. No fixture records survive.
