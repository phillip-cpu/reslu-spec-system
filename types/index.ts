// ============================================================
// RESLU Spec System — shared types
// Mirrors supabase/migrations/001_initial.sql (amended schema per
// BUILD-SPEC.md). Keep in sync with the DDL when either changes.
// ============================================================

export type ProfileRole = "admin" | "designer" | "viewer";

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: ProfileRole;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  prefix: string; // e.g. 'TW', 'LI', 'FA'
  name: string; // e.g. 'Tapware & Accessories'
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type ProjectStatus = "active" | "completed" | "archived";

export interface Project {
  id: string;
  name: string;
  client_name: string;
  address: string | null;
  status: ProjectStatus;
  budget: number | null;
  // Estimate trade markup as a fraction (e.g. 0.15 = 15%) — migration
  // 007_estimating.sql; not null default 0.
  estimate_markup_pct: number;
  monday_board_id: string | null;
  client_token: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // ---- additive (migration 009_assets_bucket.sql, Week 7) ----
  // Storage path (not a URL — the `assets` bucket is private) of the
  // project's cover image, e.g. `projects/{id}/cover.jpg`. Null if none
  // set. Served via a signed URL minted server-side — see
  // GET /api/projects/[id]/cover.
  cover_image_path: string | null;
  // ---- additive (migration 011_sow_overview.sql, Week 8A) ----
  // Traffic-light status per document kind (BUILD-SPEC.md "Project
  // overview hub"). Keyed by ProjectFileKind, missing keys mean "use
  // the kind's default" (see lib/sow.ts DEFAULT_DOCUMENT_STATUS /
  // documentStatusFor()) rather than every project needing a seeded
  // row. Team-editable via PATCH /api/projects/[id]/document-status.
  document_status: Partial<Record<ProjectFileKind, DocumentStatus>>;
  // ---- additive (migration 014_leads.sql, Week 10) ----
  // Back-link to the lead this project was created from, if any (via
  // the leads kanban's "Create project" action) — see leads.project_id
  // for the forward link and app/api/leads/[id]/create-project/route.ts.
  lead_id: string | null;
  // ---- additive (migration 017_portal_v2.sql, Week 11) ----
  // Client email for client-facing notifications (lib/notify-client.ts).
  client_email: string | null;
  // Per-project toggle for client email notifications — defaults true.
  notify_client: boolean;
  // ---- additive (migration 018_project_contacts.sql, Week 11) ----
  // Primary owner's phone + optional second owner's contact details
  // (couples: two owners on one job). All nullable.
  client_phone: string | null;
  client_secondary_name: string | null;
  client_secondary_email: string | null;
  client_secondary_phone: string | null;
}

/**
 * Project list rows may include a computed item count from the API,
 * plus a signed cover image URL (Week 7) minted server-side alongside
 * the list query — see GET /api/projects.
 */
export interface ProjectWithCounts extends Project {
  item_count?: number;
  cover_image_url?: string | null;
}

export interface LibraryItem {
  id: string;
  name: string;
  description: string | null;
  supplier: string | null;
  supplier_email: string | null;
  brand: string | null;
  category: string; // references categories.prefix
  location: string | null;
  application_note: string | null;
  colour: string | null;
  material: string | null;
  finish: string | null;
  width_mm: number | null;
  height_mm: number | null;
  length_mm: number | null;
  depth_mm: number | null;
  product_url: string | null;
  default_image_url: string | null;
  image_options: string[];
  spec_sheet_url: string | null;
  install_manual_url: string | null;
  price_rrp: number | null;
  price_trade: number | null;
  tags: string[];
  usage_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // ---- additive (migration 004_library_scraper.sql) ----
  // Trade price provenance — BUILD-SPEC.md "Library — trade price capture".
  // Financial fields: admin-gated, see app/api/library/route.ts.
  trade_price_received_at: string | null;
  trade_price_source: string | null;
  // Duplicate detection — normalised product_url (lowercase host, no
  // www., no query/fragment/trailing slash). See lib/scraper/normalize.ts.
  product_url_normalized: string | null;
}

export type ItemStatus = "Specced" | "Quoted" | "Ordered" | "On Site" | "Installed";

export type ScrapeStatus = "pending" | "success" | "partial" | "failed" | "vision" | "skipped";

export interface Item {
  id: string;
  project_id: string;
  library_item_id: string | null;

  // Identification
  item_code: string;
  category: string; // references categories.prefix

  // Core fields
  name: string;
  description: string | null;
  supplier: string | null;
  supplier_email: string | null;
  brand: string | null;
  quantity: number;
  unit: string;

  // Location / application
  location: string | null;
  application_note: string | null;

  // Spec fields
  colour: string | null;
  material: string | null;
  finish: string | null;
  width_mm: number | null;
  height_mm: number | null;
  length_mm: number | null;
  depth_mm: number | null;

  // Status lifecycle
  status: ItemStatus;

  // Product data
  product_url: string | null;
  selected_image_url: string | null;
  image_options: string[];

  // Pricing — Pricing & Procurement view only, never client portal / builder PDF
  price_rrp: number | null;
  price_trade: number | null;
  markup_pct: number | null;

  // Procurement — Pricing & Procurement view only
  lead_time_weeks: number | null;
  ordered_at: string | null;
  eta: string | null;
  delivered_at: string | null;

  // Scraping state
  scrape_status: ScrapeStatus;
  scrape_attempted_at: string | null;
  scrape_flagged: boolean;
  scrape_flag_note: string | null;

  // Client interaction
  client_approved: boolean;
  client_flagged: boolean;
  client_flag_note: string | null;
  client_actioned_at: string | null;

  // Monday.com sync
  monday_item_id: string | null;
  monday_synced_at: string | null;

  // Audit / soft-delete
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;

  // ---- additive (migration 004_library_scraper.sql) ----
  // Duplicate detection — normalised product_url. See lib/scraper/normalize.ts.
  product_url_normalized: string | null;
  // PDFs detected on the product page during scrape but not yet attached
  // as a real item_files row (BUILD-SPEC.md "Scraper extension —
  // document detection"). See types.ScrapedDocument below.
  scraped_documents: ScrapedDocument[];
  // ---- additive (migration 013_boards_contacts.sql, Week 9) ----
  // Optional link to an Address Book contact for this item's supplier.
  // Picking a contact autofills supplier/supplier_email when those
  // fields are empty (UI behaviour only — this column just stores the
  // link). See components/items/SupplierContactPicker.tsx.
  supplier_contact_id: string | null;
}

/**
 * Fields visible on the client portal and the builder-facing PDF.
 * Deliberately omits all pricing and ordering data — per BUILD-SPEC.md
 * §2: "Client portal and builder PDF never show pricing or ordering
 * data. Status is the only procurement signal outside the P&P view."
 */
export interface PortalItem {
  id: string;
  item_code: string;
  name: string;
  description: string | null;
  supplier: string | null;
  quantity: number;
  location: string | null;
  status: ItemStatus;
  selected_image_url: string | null;
  client_approved: boolean;
  client_flagged: boolean;
  client_flag_note: string | null;
}

export interface ItemNote {
  id: string;
  item_id: string;
  author_id: string | null;
  author_name: string;
  text: string;
  created_at: string;
}

export type ItemFileKind = "spec_sheet" | "install_manual" | "other";

export interface ItemFile {
  id: string;
  item_id: string;
  kind: ItemFileKind;
  storage_path: string;
  filename: string;
  uploaded_by: string | null;
  uploaded_at: string;
}

export type ApprovalAction = "approve" | "flag" | "revise";

export interface ApprovalEvent {
  id: string;
  item_id: string;
  action: ApprovalAction;
  note: string | null;
  item_snapshot: Record<string, unknown>;
  portal_token: string | null;
  created_at: string;
}

export interface ProjectLibraryItem {
  project_id: string;
  library_item_id: string;
  added_at: string;
}

// ------------------------------------------------------------
// API request/response shapes
// ------------------------------------------------------------

export interface CreateProjectInput {
  name: string;
  client_name: string;
  address?: string;
  monday_board_id?: string;
  budget?: number;
}

export interface CreateItemInput {
  name: string;
  category: string;
  quantity?: number;
  supplier?: string;
  supplier_email?: string;
  brand?: string;
  product_url?: string;
  description?: string;
  location?: string;
  application_note?: string;
  colour?: string;
  material?: string;
  finish?: string;
  width_mm?: number;
  height_mm?: number;
  length_mm?: number;
  depth_mm?: number;
  library_item_id?: string;
}

export interface ProjectsListResponse {
  projects: ProjectWithCounts[];
}

export interface ProjectResponse {
  project: Project;
}

export interface ItemsListResponse {
  items: Item[];
}

export interface ItemResponse {
  item: Item;
  notes?: ItemNote[];
}

// ------------------------------------------------------------
// CSV import (Week 2) — /projects/[id]/import, /api/projects/[id]/import
// ------------------------------------------------------------

/** body sent to POST /api/projects/[id]/import */
export interface ImportItemsInput {
  /** Raw CSV text — the server re-parses it (never trusts client-parsed rows). */
  csv: string;
  /** CSV header → item field, as confirmed by the user in the mapping step. */
  mapping: Record<string, string | null>;
}

export interface ImportRowResult {
  row: number; // 1-based data-row index (excludes header)
  item_code: string | null;
  name: string | null;
  status: "created" | "skipped_duplicate" | "error";
  reason?: string;
}

export interface ImportItemsResponse {
  created: number;
  skipped: number;
  errors: number;
  results: ImportRowResult[];
}

// ------------------------------------------------------------
// Scraper + library duplicate detection (Week 3A, additive)
// ------------------------------------------------------------

export type ScrapedDocumentKind = "spec_sheet" | "install_manual" | "other";

/**
 * A PDF (or other document) detected on a scraped product page but not
 * yet attached as a real item_files row. Staged in items.scraped_documents
 * (migration 004_library_scraper.sql). See lib/scraper/extract.ts.
 */
export interface ScrapedDocument {
  url: string;
  guessedKind: ScrapedDocumentKind;
  label: string;
}

/** body sent to POST /api/items/[id]/scrape — both fields optional. */
export interface ScrapeItemInput {
  url?: string;
}

export interface ScrapeItemResponse {
  item: Item;
}

/** body sent to POST /api/items/[id]/files/from-url */
export interface AttachFromUrlInput {
  url: string;
  kind: ItemFileKind;
}

export interface AttachFromUrlResponse {
  file: ItemFile & { url: string };
}

export type DuplicateSource = "library" | "project";

export interface DuplicateMatch {
  source: DuplicateSource;
  id: string;
  name: string;
  item_code?: string;
}

/** response shape for GET /api/library/check?url=... */
export interface CheckDuplicatesResponse {
  duplicates: DuplicateMatch[];
}

// ------------------------------------------------------------
// Estimating module (Week 5, additive) — supabase/migrations/007_estimating.sql
// BUILD-SPEC.md "Project estimating module" / "Estimating module —
// enriched from Phillip's Excel template" / "Invoice pipeline".
// Entirely admin-only, financial-gated — see app/api/projects/[id]/estimate/**
// and app/api/estimate/**. Appended here, never reordered, per this
// feature's file-boundary rules.
// ------------------------------------------------------------

export interface EstimateTemplate {
  id: string;
  name: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface EstimateTemplateSection {
  id: string;
  template_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface EstimateTemplateLine {
  id: string;
  section_id: string;
  description: string;
  unit: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface CostSection {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export type QuoteStatus = "Q" | "S" | "NA";

export interface CostLine {
  id: string;
  section_id: string;
  project_id: string;
  description: string;
  qty: number | null;
  unit: string | null;
  rate_ex_gst: number | null;
  cost_ex_gst: number | null;
  quoted_to_client_ex_gst: number | null;
  actual_paid_ex_gst: number | null;
  quote_status: QuoteStatus | null;
  item_id: string | null;
  notes: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // ---- additive (migration 009_assets_bucket.sql, Week 7) ----
  // Estimate ↔ Schedule integration: when set, this line's effective
  // qty is computed from the linked measurement's value (+ wastage_pct)
  // instead of the qty column — see lib/estimate.ts effectiveQty().
  // qty itself is left untouched by linking (unlink to hand-edit again).
  measurement_id: string | null;
  // 0–50, a percent (not a fraction) — validated server-side in
  // PATCH /api/estimate/lines/[id]. Only meaningful when measurement_id
  // is set; ignored by effectiveQty() otherwise.
  wastage_pct: number | null;
  // ---- additive (migration 013_boards_contacts.sql, Week 9) ----
  // Who's quoting/doing the trade for this line — BUILD-SPEC.md
  // "Address Book" link points. See components/estimate/ContactLinkPicker.tsx.
  contact_id: string | null;
}

/** A cost_sections row with its (non-deleted) cost_lines nested, as returned by GET /api/projects/[id]/estimate. */
export interface CostSectionWithLines extends CostSection {
  lines: CostLine[];
  /** Per-section rollup — see lib/estimate.ts sectionRollup(). */
  rollup: {
    costExGst: number;
    quotedExGst: number;
    actualExGst: number;
    variance: number | null;
  };
}

export type VariationStatus = "proposed" | "approved" | "rejected";

export interface Variation {
  id: string;
  project_id: string;
  var_number: number;
  var_date: string;
  description: string;
  cost_ex_gst: number;
  status: VariationStatus;
  approved_by: string | null;
  requested_by: string | null;
  item_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MeasurementGroup {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface Measurement {
  id: string;
  group_id: string;
  project_id: string;
  label: string;
  value: number;
  unit: string;
  item_id: string | null;
  notes: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

/** A measurement_groups row with its measurements nested, plus a computed group total. */
export interface MeasurementGroupWithRows extends MeasurementGroup {
  measurements: Measurement[];
  total: number;
}

export type InvoiceMatchType = "cost_line" | "item";
export type InvoiceStatus = "unmatched" | "proposed" | "approved" | "rejected";

/**
 * Schema-only this release (BUILD-SPEC.md "Invoice pipeline — AI-updated
 * actuals") — no UI ships against this yet, but the shape is defined now
 * so the future queue UI/Aria integration doesn't need a types change.
 */
export interface Invoice {
  id: string;
  project_id: string;
  supplier: string;
  invoice_number: string;
  invoice_date: string | null;
  amount_ex_gst: number;
  gst: number;
  total: number;
  storage_path: string | null;
  proposed_match_type: InvoiceMatchType | null;
  proposed_match_id: string | null;
  confidence_note: string | null;
  status: InvoiceStatus;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// FF&E — from schedule (Week 6, additive) — see lib/estimate.ts
// ffeRollup()/wholeJobSummary(). Computed from items, never persisted.
// ------------------------------------------------------------

export type FfeConfidence = "quoted" | "placeholder" | "unpriced";

export interface FfeCategoryRollup {
  category: string;
  item_count: number;
  total: number;
  quoted_share: number;
  quoted_count: number;
  placeholder_count: number;
  unpriced_count: number;
}

export interface FfeRollup {
  categories: FfeCategoryRollup[];
  total: number;
  quoted_total: number;
  placeholder_total: number;
  item_count: number;
  quoted_count: number;
  placeholder_count: number;
  unpriced_count: number;
  quoted_share: number;
  placeholder_share: number;
}

export interface WholeJobSummary {
  trades: EstimateResponse["rollup"];
  ffe: FfeRollup;
  combinedExGst: number;
  combinedGst: number;
  combinedIncGst: number;
}

/** GET /api/projects/[id]/estimate response — sections+lines plus the whole-job rollup. */
export interface EstimateResponse {
  sections: CostSectionWithLines[];
  markup_pct: number;
  rollup: {
    allTradesSubtotalExGst: number;
    approvedVariationsExGst: number;
    markupPct: number;
    markupExGst: number;
    totalToClientExGst: number;
    gst: number;
    totalIncGst: number;
    quotedExGst: number;
    actualExGst: number;
  };
  /** FF&E — from schedule block (Week 6, additive) — see lib/estimate.ts ffeRollup(). */
  ffe: FfeRollup;
  /** Whole-job summary folding FF&E in AFTER trade markup — see lib/estimate.ts wholeJobSummary(). */
  wholeJob: WholeJobSummary;
  /**
   * Every measurement for the project, flat, with its group's name
   * attached (Week 7 — Estimate ↔ Schedule integration). Used to
   * resolve a linked cost line's measurement_id to a label/value/unit
   * for display, and to populate the "link a measurement" picker
   * grouped by measurement group, without a second fetch.
   */
  measurements: MeasurementWithGroup[];
}

/** POST /api/projects/[id]/estimate/init response. */
export interface EstimateInitResponse {
  sections: CostSectionWithLines[];
}

/** body accepted by PATCH /api/estimate/lines/[id] — all fields optional, partial update. */
export interface PatchCostLineInput {
  description?: string;
  qty?: number | null;
  unit?: string | null;
  rate_ex_gst?: number | null;
  cost_ex_gst?: number | null;
  quoted_to_client_ex_gst?: number | null;
  actual_paid_ex_gst?: number | null;
  quote_status?: QuoteStatus | null;
  item_id?: string | null;
  notes?: string | null;
  sort?: number;
  /** Week 7 — Estimate ↔ Schedule integration: link/unlink a measurement. */
  measurement_id?: string | null;
  /** Week 7 — 0–50 (percent), only meaningful alongside measurement_id. */
  wastage_pct?: number | null;
  /** Week 9 — link/unlink an Address Book contact (who's quoting/doing the trade). */
  contact_id?: string | null;
}

/**
 * A measurement row annotated with its group's name — the shape the
 * Estimate tab needs to both (a) resolve a linked cost line's
 * measurement_id to a human label, and (b) group the link picker by
 * measurement group, without a second round-trip to the measurements
 * endpoint (BUILD-SPEC.md "Estimate ↔ Schedule integration": "link icon
 * on a line → picker of measurements (grouped by measurement group)").
 */
export interface MeasurementWithGroup extends Measurement {
  group_name: string;
}

/** body accepted by POST /api/estimate/sections/[sectionId]/lines. */
export interface CreateCostLineInput {
  description: string;
  qty?: number | null;
  unit?: string | null;
  rate_ex_gst?: number | null;
  cost_ex_gst?: number | null;
  quoted_to_client_ex_gst?: number | null;
  actual_paid_ex_gst?: number | null;
  quote_status?: QuoteStatus | null;
  item_id?: string | null;
  notes?: string | null;
}

/** body accepted by POST /api/projects/[id]/estimate/sections. */
export interface CreateCostSectionInput {
  name: string;
}

/** body accepted by POST /api/projects/[id]/estimate/variations. */
export interface CreateVariationInput {
  description: string;
  var_date?: string;
  cost_ex_gst?: number;
  status?: VariationStatus;
  approved_by?: string;
  requested_by?: string;
  item_id?: string;
  notes?: string;
}

/** body accepted by PATCH /api/estimate/variations/[id]. */
export interface PatchVariationInput {
  description?: string;
  var_date?: string;
  cost_ex_gst?: number;
  status?: VariationStatus;
  approved_by?: string | null;
  requested_by?: string | null;
  item_id?: string | null;
  notes?: string | null;
}

/** body accepted by POST /api/projects/[id]/estimate/measurements/groups. */
export interface CreateMeasurementGroupInput {
  name: string;
}

/** body accepted by POST /api/estimate/measurements/groups/[groupId]/measurements. */
export interface CreateMeasurementInput {
  label: string;
  value?: number;
  unit?: string;
  item_id?: string;
  notes?: string;
}

/** body accepted by PATCH /api/estimate/measurements/[id]. */
export interface PatchMeasurementInput {
  label?: string;
  value?: number;
  unit?: string;
  item_id?: string | null;
  notes?: string | null;
}

// ------------------------------------------------------------
// Project documents (Week 6, additive) — supabase/migrations/008_project_files.sql
// BUILD-SPEC.md "Project documents". Team-visible (not admin-gated —
// documents aren't financial), see app/api/projects/[id]/files/**.
// ------------------------------------------------------------

export type ProjectFileKind = "plans" | "council" | "engineering" | "scope_of_works" | "other";

export interface ProjectFile {
  id: string;
  project_id: string;
  kind: ProjectFileKind;
  storage_path: string;
  filename: string;
  revision_label: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  deleted_at: string | null;
}

/** GET /api/projects/[id]/files response — files include a minted public URL. */
export interface ProjectFilesListResponse {
  files: (ProjectFile & { url: string })[];
}

/** multipart body accepted by POST /api/projects/[id]/files: { file, kind, revision_label? }. */
export interface UploadProjectFileResponse {
  file: ProjectFile & { url: string };
}

// ------------------------------------------------------------
// Invoice pipeline (Week 6, additive) — routes over the invoices table
// defined in 007_estimating.sql. Admin-only, financial — see
// app/api/projects/[id]/invoices/** and app/api/invoices/**.
// ------------------------------------------------------------

/** body accepted by POST /api/projects/[id]/invoices. */
export interface CreateInvoiceInput {
  supplier: string;
  invoice_number: string;
  invoice_date?: string | null;
  amount_ex_gst: number;
  gst?: number;
  total?: number;
  proposed_match_type?: InvoiceMatchType | null;
  proposed_match_id?: string | null;
  confidence_note?: string | null;
}

/** response shape for POST /api/projects/[id]/invoices. */
export interface CreateInvoiceResponse {
  invoice: Invoice;
  /** Present when an existing non-rejected invoice matches (project, supplier, invoice_number). */
  duplicate_warning?: Invoice;
}

/** body accepted by PATCH /api/invoices/[id]. */
export interface PatchInvoiceInput {
  supplier?: string;
  invoice_number?: string;
  invoice_date?: string | null;
  amount_ex_gst?: number;
  gst?: number;
  total?: number;
  proposed_match_type?: InvoiceMatchType | null;
  proposed_match_id?: string | null;
  confidence_note?: string | null;
}

export interface GetInvoicesResponse {
  invoices: Invoice[];
}

// ------------------------------------------------------------
// Project overview hub + document traffic lights (Week 8A, additive)
// supabase/migrations/011_sow_overview.sql. BUILD-SPEC.md "Project
// overview hub". Team-visible (not admin-gated — a document's
// completion status isn't financial), see
// app/api/projects/[id]/document-status/route.ts.
// ------------------------------------------------------------

export type DocumentStatus = "na" | "not_started" | "draft" | "done";

/** body accepted by PATCH /api/projects/[id]/document-status. */
export interface PatchDocumentStatusInput {
  kind: ProjectFileKind;
  status: DocumentStatus;
}

/**
 * GET /api/projects/[id]/overview response — the cards on the
 * Overview tab, computed server-side so the client never re-derives
 * rollups from raw items/cost_lines/approval_events itself.
 */
export interface ProjectOverviewResponse {
  project: Project;
  ffe: {
    item_count: number;
    approved_count: number;
    flagged_count: number;
    ordered_count: number;
  };
  documents: {
    /** Every tracked kind (plans/council/engineering/scope_of_works),
     *  each resolved to an effective status (see lib/sow.ts
     *  documentStatusFor()) plus the latest revision label, if any. */
    kind: ProjectFileKind;
    status: DocumentStatus;
    latest_revision_label: string | null;
  }[];
  /** Present only for admins — the whole estimate summary is financial
   *  data, per BUILD-SPEC.md "Financial visibility". */
  estimate: {
    total_inc_gst: number;
    percent_quoted: number;
    variance: number | null;
  } | null;
  client_activity: (ApprovalEvent & { item_code: string | null; item_name: string | null })[];
}

// ------------------------------------------------------------
// Scope of Works builder (Week 8A, additive)
// supabase/migrations/011_sow_overview.sql. BUILD-SPEC.md "Scope of
// Works builder". Team access (not admin-gated — a SOW isn't
// financial data), see app/api/projects/[id]/sow/**. Aria-relevant:
// these routes let Aria draft a SOW from project docs and the team
// refines it (BUILD-SPEC.md "Aria integration").
// ------------------------------------------------------------

export type SowStatus = "draft" | "issued";
export type SowLineKind = "inclusion" | "exclusion" | "note";

export interface SowDocument {
  id: string;
  project_id: string;
  revision_label: string;
  status: SowStatus;
  issued_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SowSection {
  id: string;
  sow_id: string;
  heading: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface SowLine {
  id: string;
  section_id: string;
  text: string;
  kind: SowLineKind;
  sort: number;
  created_at: string;
  updated_at: string;
}

/** A sow_sections row with its sow_lines nested, as returned by GET /api/projects/[id]/sow/[sowId]. */
export interface SowSectionWithLines extends SowSection {
  lines: SowLine[];
}

/** GET /api/projects/[id]/sow response — every revision, newest first, for the revision picker. */
export interface SowListResponse {
  sow_documents: SowDocument[];
}

/** GET /api/projects/[id]/sow/[sowId] response. */
export interface SowDetailResponse {
  sow: SowDocument;
  sections: SowSectionWithLines[];
}

/** body accepted by POST /api/projects/[id]/sow — creates the first draft (T1) for a project. */
export interface CreateSowInput {
  revision_label?: string;
}

/** body accepted by POST /api/projects/[id]/sow/[sowId]/sections. */
export interface CreateSowSectionInput {
  heading: string;
}

/** body accepted by PATCH /api/sow/sections/[sectionId]. */
export interface PatchSowSectionInput {
  heading?: string;
  sort?: number;
}

/** body accepted by POST /api/sow/sections/[sectionId]/lines. */
export interface CreateSowLineInput {
  text: string;
  kind?: SowLineKind;
}

/** body accepted by PATCH /api/sow/lines/[lineId]. */
export interface PatchSowLineInput {
  text?: string;
  kind?: SowLineKind;
  sort?: number;
}

/** response shape for POST /api/projects/[id]/sow/[sowId]/issue and .../new-revision. */
export interface SowActionResponse {
  sow: SowDocument;
}

// ------------------------------------------------------------
// Week 9 — Boards, Gantt, Address Book (additive)
// supabase/migrations/013_boards_contacts.sql. BUILD-SPEC.md "Week 9 —
// detailed scope". None of this is financial data — team-visible, not
// admin-gated. See app/api/contacts/**, app/api/projects/[id]/board/**,
// app/api/board-tasks/**, app/api/board-columns/**,
// app/api/projects/[id]/phases/**, app/api/phases/**.
// ------------------------------------------------------------

export interface Contact {
  id: string;
  company: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  specialty: string | null;
  category: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** body accepted by POST /api/contacts. */
export interface CreateContactInput {
  company: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  specialty?: string | null;
  category?: string | null;
  notes?: string | null;
}

/** body accepted by PATCH /api/contacts/[id] — all fields optional, partial update. */
export interface PatchContactInput {
  company?: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  specialty?: string | null;
  category?: string | null;
  notes?: string | null;
}

export interface ContactsListResponse {
  contacts: Contact[];
}

/**
 * A contact reduced to just what a card/chip/picker needs to render —
 * used wherever a linked contact is joined onto another row (board
 * tasks, items, cost lines, phases) so the API doesn't have to return
 * a full Contact for a lightweight display chip.
 */
export interface ContactSummary {
  id: string;
  company: string;
  contact_name: string | null;
}

// ---- Project board (kanban) ----

export interface BoardColumn {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface BoardTask {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string | null;
  assignee_id: string | null;
  contact_id: string | null;
  due_date: string | null;
  sort: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A board_tasks row annotated with lightweight assignee/contact display data — see GET /api/projects/[id]/board. */
export interface BoardTaskWithRefs extends BoardTask {
  assignee: { id: string; full_name: string } | null;
  contact: ContactSummary | null;
}

/** A board_columns row with its (non-deleted) tasks nested, as returned by GET /api/projects/[id]/board. */
export interface BoardColumnWithTasks extends BoardColumn {
  tasks: BoardTaskWithRefs[];
}

/** GET /api/projects/[id]/board response. */
export interface BoardResponse {
  columns: BoardColumnWithTasks[];
}

/** body accepted by POST /api/projects/[id]/board (creates a task). */
export interface CreateBoardTaskInput {
  column_id: string;
  title: string;
  description?: string | null;
  assignee_id?: string | null;
  contact_id?: string | null;
  due_date?: string | null;
}

/** body accepted by PATCH /api/board-tasks/[id]. */
export interface PatchBoardTaskInput {
  column_id?: string;
  title?: string;
  description?: string | null;
  assignee_id?: string | null;
  contact_id?: string | null;
  due_date?: string | null;
  sort?: number;
}

/** body accepted by POST /api/projects/[id]/board/columns. */
export interface CreateBoardColumnInput {
  name: string;
}

/** body accepted by PATCH /api/board-columns/[id]. */
export interface PatchBoardColumnInput {
  name?: string;
  sort?: number;
}

// ---- Gantt (schedule phases) ----

export type PhaseColorKey = "sand" | "charcoal" | "teal" | "amber";

export interface SchedulePhase {
  id: string;
  project_id: string;
  name: string;
  start_date: string;
  end_date: string;
  color_key: PhaseColorKey;
  contact_id: string | null;
  sort: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A schedule_phases row annotated with lightweight contact display data — see GET /api/projects/[id]/phases. */
export interface SchedulePhaseWithContact extends SchedulePhase {
  contact: ContactSummary | null;
}

export interface PhasesListResponse {
  phases: SchedulePhaseWithContact[];
}

/** body accepted by POST /api/projects/[id]/phases. */
export interface CreatePhaseInput {
  name: string;
  start_date: string;
  end_date: string;
  color_key?: PhaseColorKey;
  contact_id?: string | null;
  notes?: string | null;
}

/** body accepted by PATCH /api/phases/[id]. */
export interface PatchPhaseInput {
  name?: string;
  start_date?: string;
  end_date?: string;
  color_key?: PhaseColorKey;
  contact_id?: string | null;
  notes?: string | null;
  sort?: number;
}

/**
 * Read-only portal mirror of a phase — BUILD-SPEC.md "Portal mirror":
 * "phase names + bars + date ranges ONLY (no contacts, no notes)".
 * See app/portal/[token]/page.tsx and components/portal/TimelineSection.tsx.
 */
export interface PortalPhase {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  color_key: PhaseColorKey;
}

// ---- Leads pipeline (Week 10) ----

export type LeadSource = "META" | "DIRECT";

/** Pipeline order — the 10 stages, in the exact order the kanban board
 * renders its columns (see components/leads/LeadsBoard.tsx). Not
 * alphabetical. Mirrors the CHECK constraint in
 * supabase/migrations/014_leads.sql letter-for-letter. */
export const LEAD_STAGES = [
  "Potential Lead",
  "Site Visit Booked",
  "Awaiting to Send Proposal",
  "Proposal Sent",
  "Design Work In Progress",
  "Construction In Progress",
  "Unable to Contact",
  "Lead Lost",
  "Complete",
  "Potential Future Lead",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

/** Stages excluded from "active pipeline" totals (BUILD-SPEC.md
 * "Pipeline dashboard": "total pipeline value (sum construction_value
 * in active stages — exclude Lost/Complete/Unable/Future)"). */
export const INACTIVE_LEAD_STAGES: LeadStage[] = [
  "Unable to Contact",
  "Lead Lost",
  "Complete",
  "Potential Future Lead",
];

export interface Lead {
  id: string;
  surname_project: string;
  first_name: string | null;
  source: LeadSource | null;
  stage: LeadStage;
  email: string | null;
  phone: string | null;
  location: string | null;
  received_at: string | null;
  follow_up_date: string | null;
  site_visit_date: string | null;
  site_visit_location: string | null;
  construction_value: number | null;
  design_value: number | null;
  design_start: string | null;
  design_end: string | null;
  construction_start: string | null;
  construction_end: string | null;
  monday_item_id: string | null;
  notes: string | null;
  project_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface LeadStageEvent {
  id: string;
  lead_id: string;
  from_stage: LeadStage | null;
  to_stage: LeadStage;
  at: string;
}

/** body accepted by POST /api/leads. */
export interface CreateLeadInput {
  surname_project: string;
  first_name?: string | null;
  source?: LeadSource | null;
  stage?: LeadStage;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  received_at?: string | null;
  follow_up_date?: string | null;
  site_visit_date?: string | null;
  site_visit_location?: string | null;
  construction_value?: number | null;
  design_value?: number | null;
  design_start?: string | null;
  design_end?: string | null;
  construction_start?: string | null;
  construction_end?: string | null;
  notes?: string | null;
}

/** body accepted by PATCH /api/leads/[id]. Includes every editable
 * field EXCEPT `stage` — stage changes go through the dedicated
 * POST /api/leads/[id]/stage route so a lead_stage_events row is
 * guaranteed (the DB trigger fires either way, but the dedicated
 * route is the one documented call path for Aria/UI drag-drop). A
 * plain PATCH that includes `stage` is still accepted (the trigger
 * covers it), but is not the documented primary path. */
export interface PatchLeadInput {
  surname_project?: string;
  first_name?: string | null;
  source?: LeadSource | null;
  stage?: LeadStage;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  received_at?: string | null;
  follow_up_date?: string | null;
  site_visit_date?: string | null;
  site_visit_location?: string | null;
  construction_value?: number | null;
  design_value?: number | null;
  design_start?: string | null;
  design_end?: string | null;
  construction_start?: string | null;
  construction_end?: string | null;
  notes?: string | null;
}

/** body accepted by POST /api/leads/[id]/stage. */
export interface MoveLeadStageInput {
  stage: LeadStage;
}

export interface LeadsListResponse {
  leads: Lead[];
}

export interface LeadResponse {
  lead: Lead;
}

/** GET /api/leads/attention response — BUILD-SPEC.md "Needs-attention
 * panel": "Proposal Sent >=4 days (nurture candidates) + Awaiting to
 * Send Proposal >=7 days (stale proposals) + follow_up_date
 * due/past" + "site_visits_upcoming: next 7 days". */
export interface LeadsAttentionResponse {
  nurture: Lead[];
  stale_proposals: Lead[];
  follow_ups_due: Lead[];
  site_visits_upcoming: Lead[];
}

/** Per-stage aggregate for the pipeline dashboard strip. */
export interface LeadStageSummary {
  stage: LeadStage;
  count: number;
  value: number;
  avg_days_in_stage: number | null;
}

/** GET /api/leads dashboard summary, folded into the list response
 * when `?summary=1` — see docs/API.md. */
export interface LeadsDashboardSummary {
  total_pipeline_value: number;
  stages: LeadStageSummary[];
}

// ============================================================
// Rooms + per-room item quantities (migration 015_rooms.sql)
// ============================================================

/** A room within a project (Ensuite, Bathroom, …). */
export interface Room {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** An item's allocation to a room, carrying the per-room quantity. */
export interface ItemRoom {
  id: string;
  item_id: string;
  room_id: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

/** Room list row with how many items are assigned to it. */
export interface RoomWithCount extends Room {
  item_count: number;
}

/** One item's room allocations, for showing chips on the spec register. */
export interface ItemRoomAllocation {
  room_id: string;
  room_name: string;
  quantity: number;
}

/** POST /api/projects/[id]/rooms — create a room. */
export interface CreateRoomInput {
  name: string;
}

/**
 * POST /api/projects/[id]/items/rooms — bulk-assign items to rooms.
 * Each selected item is upserted into each target room at `quantity`
 * (existing allocations for those item/room pairs are updated, not
 * duplicated). `mode: "replace"` first clears the items' other room
 * allocations; "add" leaves untouched rooms in place.
 */
export interface BulkAssignRoomsInput {
  item_ids: string[];
  room_ids: string[];
  quantity: number;
  mode: "add" | "replace";
}

/** One room allocation across the whole project
 * (GET /api/projects/[id]/items/rooms) — used for room grouping + per-item editor. */
export interface ProjectAllocation {
  item_id: string;
  room_id: string;
  room_name: string;
  quantity: number;
}
