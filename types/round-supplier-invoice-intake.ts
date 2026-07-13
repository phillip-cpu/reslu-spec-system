// ============================================================
// RESLU Spec System — Aria supplier-invoice intake (r24) LOCAL types.
// docs/BUILD-SPEC.md §"Booking selection v2 + Aria supplier invoices
// (r24)", items 5-8.
//
// Deliberately NOT added to types/index.ts (protected, out of this
// round's edit boundary) — same "one types/round-*.ts file per round"
// house convention types/round-grouped-trade-booking.ts (r20) and
// every other round-local types file already follows. `InvoiceWithIntake`
// is a structural superset of the base `Invoice` type (types/index.ts,
// migration 007) — every existing route/component that only ever knew
// about the base fields keeps working unchanged; routes/components
// touched by this round import `InvoiceWithIntake` instead wherever
// they need the new columns (migration 052).
// ============================================================

import type { Invoice } from "@/types";

export type InvoiceSource = "manual" | "aria";

/**
 * Aria's raw extraction payload (invoices.extracted, migration 052) —
 * shown read-only as context in the approval UI. The canonical
 * amount_ex_gst/gst/total/invoice_date/supplier/invoice_number columns
 * on the base Invoice are what Approve actually applies; this is only
 * "what Aria originally read off the PDF", which may drift from the
 * canonical columns if an admin edits them during review.
 */
export interface SupplierInvoiceExtracted {
  supplier?: string;
  abn?: string | null;
  invoice_number?: string;
  invoice_date?: string | null;
  total_inc_gst?: number;
  gst?: number;
  /** Free text — which line items Aria thinks this invoice covers, and why. */
  line_hints?: string | null;
  /** Free text — which project/job Aria matched this against, and why (job number, address, contact name mentioned in the email, etc). */
  job_hints?: string | null;
}

/** `invoices` (007_estimating.sql) + migration 052's additive columns. */
export interface InvoiceWithIntake extends Invoice {
  source: InvoiceSource;
  source_email_id: string | null;
  extracted: SupplierInvoiceExtracted | null;
  library_cost_applied: boolean;
}

/** body accepted by POST /api/invoices/[id]/approve (r24 addition — see that route's own doc comment for the cost flow-through this drives). */
export interface ApproveInvoiceInput {
  /**
   * Per-line "update the linked library product's cost record" toggle
   * (BUILD-SPEC.md item 7). Omit to use the server-side default: ON
   * when the matched item (directly, for an `item` match, or via the
   * matched cost_line's own item_id, for a `cost_line` match) carries a
   * library_item_id, OFF otherwise (nothing to update).
   */
  apply_to_library_cost?: boolean;
}

export interface ApproveInvoiceResponse {
  invoice: InvoiceWithIntake;
  warning?: string;
  /** Set true when this approval also wrote invoices.library_cost_applied — mirrors that column, present on the response so the UI can show a one-off confirmation toast without a second fetch. */
  library_cost_applied?: boolean;
}
