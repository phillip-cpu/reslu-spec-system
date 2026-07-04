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
  monday_board_id: string | null;
  client_token: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Project list rows may include a computed item count from the API. */
export interface ProjectWithCounts extends Project {
  item_count?: number;
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
