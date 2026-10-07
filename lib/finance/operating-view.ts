import type { FinanceOperatingViewScope } from "../../types/finance";
import type { CachedXeroInvoice } from "./xero-actuals";

// Explicit operating-view classification requested by Phillip. These receivables
// belong to Nathan; company records and liabilities retain their original scope.
export const NATHAN_RECEIVABLE_CONTACT_IDS = [
  "bf85bda0-6881-4c30-aabb-dab3b283c914", // Fairmont Homes
  "3499f3f7-ba08-4417-abc9-ae002a68aa0f", // Crouch Construction
] as const;
const nathanContactIds = new Set<string>(NATHAN_RECEIVABLE_CONTACT_IDS);

function outstandingMinor(invoice: CachedXeroInvoice): number {
  if (!["AUTHORISED", "PAID"].includes(invoice.status.toUpperCase())) return 0;
  const values = [invoice.total, invoice.amount_paid, invoice.amount_credited].map(
    (value) => Math.round(Math.max(Number(value ?? 0), 0) * 100)
  );
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("Operating-view receivable amount exceeds safe minor units");
  }
  return Math.max(values[0] - values[1] - values[2], 0);
}

/** Filter before reconciliation; never mutate invoices, payments or pooled cash. */
export function selectOperatingViewInvoices(
  invoices: CachedXeroInvoice[],
  scope: FinanceOperatingViewScope
) {
  const excluded = scope === "phillip" ? invoices.filter((invoice) =>
    invoice.invoice_type === "ACCREC" &&
    nathanContactIds.has(invoice.contact_id?.toLowerCase() ?? "")
  ) : [];
  const excludedIds = new Set(excluded.map((invoice) => invoice.xero_invoice_id));
  const outstanding = excluded.map(outstandingMinor);
  const total = outstanding.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Operating-view total exceeds safe minor units");
  return {
    invoices: invoices.filter((invoice) => !excludedIds.has(invoice.xero_invoice_id)),
    summary: {
      scope,
      excluded_receivable_count: excluded.length,
      excluded_outstanding_count: outstanding.filter((amount) => amount > 0).length,
      excluded_outstanding_minor: total,
      opening_cash_scope: "company_pooled" as const,
    },
  };
}
