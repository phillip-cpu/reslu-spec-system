// ============================================================
// RESLU Spec System — Client invoicing, phase 1 (design fees).
// Types for `client_invoices` (migration 046_client_invoices.sql) and
// its API routes. Kept in its own file per this codebase's house
// convention of one types/round-*.ts (or types/<feature>.ts) file per
// round, rather than editing the shared types/index.ts (out of this
// round's edit boundary — see types/sow-trade-tags.ts and
// types/visit-emails.ts for the same convention, documented there).
//
// NAME COLLISION NOTE: `ClientInvoice` here is unrelated to the
// existing `Invoice` type in types/index.ts (that one is a SUPPLIER
// invoice — money OUT, matched against cost lines/items). This is
// money IN — RESLU billing its own client. Every type below is
// prefixed ClientInvoice* to keep the two families visually distinct
// at every import site.
// ============================================================

export type ClientInvoiceKind = "design_fee" | "other";
export type ClientInvoiceStatus = "draft" | "sent" | "paid" | "void";

/** One row of client_invoices.line_items (jsonb array). */
export interface ClientInvoiceLineItem {
  description: string;
  amount_ex_gst: number;
}

export interface ClientInvoice {
  id: string;
  project_id: string | null;
  /** QA fix round (r27) item 7, migration 054. Nullable — only ever set
   * when this invoice was drafted project_id-null off a lead-only
   * accepted proposal (POST /api/proposal/[token]/accept); left set as
   * history after POST /api/leads/[id]/create-project backfills
   * project_id. See that column's own migration comment. */
  lead_id?: string | null;
  invoice_number: string;
  kind: ClientInvoiceKind;
  client_name: string;
  client_email: string | null;
  address: string | null;
  line_items: ClientInvoiceLineItem[];
  subtotal_ex_gst: number;
  gst: number;
  total_inc_gst: number;
  status: ClientInvoiceStatus;
  due_days: number;
  issued_at: string | null;
  paid_at: string | null;
  stripe_payment_url: string | null;
  stripe_payment_link_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** GET /api/projects/[id]/client-invoices response. */
export interface ClientInvoicesListResponse {
  invoices: ClientInvoice[];
}

/** GET /api/client-invoices/unlinked response — QA fix round (r27)
 * item 7's "Unlinked invoices" list (components/leads/
 * UnlinkedInvoicesPanel.tsx, on the admin-only /leads page). Every
 * non-deleted client_invoices row with project_id still null, whether
 * or not it carries a lead_id — a manually-created orphan (no lead at
 * all) must be just as visible as a lead-originated one. */
export interface UnlinkedClientInvoicesResponse {
  invoices: ClientInvoice[];
}

/** POST /api/projects/[id]/client-invoices body. Server computes
 * invoice_number + totals — never accepted from the client. */
export interface CreateClientInvoiceInput {
  kind?: ClientInvoiceKind;
  client_name: string;
  client_email?: string | null;
  address?: string | null;
  line_items: ClientInvoiceLineItem[];
  due_days?: number;
  notes?: string | null;
}

/** PATCH /api/client-invoices/[id] body. Only permitted while
 * status = 'draft' (see route doc comment) — line_items/client
 * fields are frozen the moment an invoice is sent, matching the
 * "a sent/paid tax invoice's totals must never drift" rule in the
 * migration's own column comments. */
export interface PatchClientInvoiceInput {
  kind?: ClientInvoiceKind;
  client_name?: string;
  client_email?: string | null;
  address?: string | null;
  line_items?: ClientInvoiceLineItem[];
  due_days?: number;
  notes?: string | null;
}

export interface ClientInvoiceResponse {
  invoice: ClientInvoice;
}

/** app_settings key 'invoice_bank_details' — see lib/bank-details.ts. */
export interface InvoiceBankDetails {
  account_name: string;
  bsb: string;
  account_number: string;
}

export interface BankDetailsResponse {
  bank_details: InvoiceBankDetails | null;
}
