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
