import type { InvoiceBankDetails } from "@/types/client-invoices";

// ============================================================
// RESLU Spec System — Client invoicing, phase 1 (design fees).
// Bank transfer details shown on every client invoice PDF/email
// (BUILD-SPEC.md DECISIONS: "bank transfer standard, Stripe optional
// for small invoices"). Stored in app_settings under key
// 'invoice_bank_details' — same generic key/value store every other
// Settings editor already uses (lib/export-presets.ts,
// lib/phase-template.ts, etc.), read/written directly by
// app/api/settings/bank-details/route.ts (PUT admin-only) and
// app/(dashboard)/settings/page.tsx (server-side initial read).
//
// NO FALLBACK VALUES: unlike every other app_settings-backed feature in
// this codebase (which ships a code-level FALLBACK_* constant of real
// starting data), bank account numbers must NEVER be invented or
// guessed — there is deliberately no FALLBACK_BANK_DETAILS constant
// here. Until an admin fills this in via Settings, GET returns
// `{ bank_details: null }` and every invoice PDF/email prints "Bank
// details not configured" instead of a payment panel (see
// components/pdf/InvoicePdf.tsx). This is a one-time on-machine setup
// step for Phillip — see README.md "Client invoicing setup".
// ============================================================

export const BANK_DETAILS_SETTINGS_KEY = "invoice_bank_details";

/**
 * Validates a raw PUT body into a clean InvoiceBankDetails object, or
 * null if any field is missing/blank. All three fields are required
 * together — a half-filled bank-details row (e.g. account name but no
 * BSB) is treated as "not configured" by the PDF (see
 * components/pdf/InvoicePdf.tsx's own null-check), so the API refuses
 * to save a partial row in the first place rather than allowing a
 * confusing in-between state.
 */
export function cleanBankDetails(raw: unknown): InvoiceBankDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const account_name = typeof (raw as { account_name?: unknown }).account_name === "string"
    ? (raw as { account_name: string }).account_name.trim()
    : "";
  const bsb = typeof (raw as { bsb?: unknown }).bsb === "string"
    ? (raw as { bsb: string }).bsb.trim()
    : "";
  const account_number = typeof (raw as { account_number?: unknown }).account_number === "string"
    ? (raw as { account_number: string }).account_number.trim()
    : "";
  if (!account_name || !bsb || !account_number) return null;
  return { account_name, bsb, account_number };
}
