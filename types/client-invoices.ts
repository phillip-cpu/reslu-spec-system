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
export type ClientInvoiceSource = "reslu" | "manual";
export type ClientContractType = "design" | "construction" | "other";
export type ClientPaymentTriggerType = "contract_signed" | "schedule_phase" | "manual";

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
  source?: ClientInvoiceSource;
  payment_schedule_item_id?: string | null;
  contract_snapshot?: ClientContractSnapshot;
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
  billing_profile: ClientBillingProfile | null;
  payment_schedule: ClientPaymentScheduleItem[];
  schedule_phases: ClientSchedulePhase[];
  approved_variations: ClientApprovedVariation[];
}

export interface ClientBillingProfile {
  project_id: string;
  contract_type: ClientContractType;
  contract_label: string;
  contract_amount_inc_gst: number;
  due_days: number;
  contract_reference: string | null;
  contract_signed_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ClientPaymentScheduleItem {
  id: string;
  project_id: string;
  label: string;
  percentage: number | null;
  amount_inc_gst: number;
  milestone_date: string | null;
  trigger_type: ClientPaymentTriggerType;
  schedule_phase_id: string | null;
  sort: number;
  client_invoice_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ClientSchedulePhase {
  id: string;
  project_id?: string;
  name: string;
  start_date: string;
  end_date: string;
  sort: number;
}

export interface ClientApprovedVariation {
  id: string;
  var_number: number;
  description: string;
  amount_ex_gst: number;
  amount_inc_gst: number;
  approved_at?: string | null;
}

export interface ClientContractSnapshotEntry {
  id?: string;
  label: string;
  amount_inc_gst: number;
  invoice_number?: string | null;
  issued_at?: string | null;
  paid_at?: string | null;
  status?: ClientInvoiceStatus | "planned";
}

export interface ClientContractSnapshot {
  contract_type?: ClientContractType;
  contract_label?: string;
  original_contract_inc_gst?: number;
  approved_variations_inc_gst?: number;
  adjusted_contract_inc_gst?: number;
  variations?: ClientApprovedVariation[];
  previous_payments?: ClientContractSnapshotEntry[];
  current_claim?: ClientContractSnapshotEntry | null;
  future_payments?: ClientContractSnapshotEntry[];
  remaining_after_claim_inc_gst?: number;
}

export interface SaveClientBillingInput {
  contract_type: ClientContractType;
  contract_label: string;
  contract_amount_inc_gst: number;
  due_days: number;
  payment_schedule: Array<{
    id?: string;
    label: string;
    percentage?: number | null;
    amount_inc_gst: number;
    milestone_date?: string | null;
    trigger_type: ClientPaymentTriggerType;
    schedule_phase_id?: string | null;
    sort: number;
  }>;
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
  source?: ClientInvoiceSource;
  invoice_number?: string;
  status?: Extract<ClientInvoiceStatus, "sent" | "paid">;
  issued_at?: string;
  paid_at?: string | null;
  payment_schedule_item_id?: string | null;
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
