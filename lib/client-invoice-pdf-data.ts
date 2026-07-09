import type { SupabaseClient } from "@supabase/supabase-js";
import { BANK_DETAILS_SETTINGS_KEY } from "@/lib/bank-details";
import type { ClientInvoice, InvoiceBankDetails } from "@/types/client-invoices";

// ============================================================
// RESLU Spec System — Client invoicing, phase 1 (design fees).
// Shared "load everything InvoicePdf needs" helper — used by BOTH
// GET /api/client-invoices/[id]/pdf (preview/download) and
// POST /api/client-invoices/[id]/send (renders the SAME PDF to attach
// to the email), so the two never drift out of sync with each other.
// ============================================================

export interface ClientInvoicePdfData {
  invoice: ClientInvoice;
  bankDetails: InvoiceBankDetails | null;
  dateLabel: string;
}

/** Returns null when the invoice doesn't exist (or is soft-deleted) —
 * callers respond 404. */
export async function loadClientInvoicePdfData(
  supabase: SupabaseClient,
  invoiceId: string
): Promise<ClientInvoicePdfData | null> {
  const [{ data: invoice, error: invoiceError }, { data: bankRow }] = await Promise.all([
    supabase
      .from("client_invoices")
      .select("*")
      .eq("id", invoiceId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", BANK_DETAILS_SETTINGS_KEY).maybeSingle(),
  ]);

  if (invoiceError || !invoice) return null;

  const bankDetails = (bankRow?.value as InvoiceBankDetails | undefined) ?? null;

  const generatedAt = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const dateLabel = invoice.issued_at
    ? new Date(invoice.issued_at as string).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : generatedAt;

  return { invoice: invoice as ClientInvoice, bankDetails, dateLabel };
}
