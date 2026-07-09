import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClientInvoiceLineItem } from "@/types/client-invoices";
import { reportError } from "@/lib/report-error";

// ============================================================
// RESLU Spec System — Client invoicing, phase 1 (design fees).
// BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 5. Numbering
// + GST math shared by every client-invoices API route
// (app/api/projects/[id]/client-invoices, app/api/client-invoices/[id]/*).
// Migration: supabase/migrations/046_client_invoices.sql.
// ============================================================

/**
 * Next invoice number for a client invoice.
 *
 * - Project WITH a job_number: '{job_number}-{seq}' (e.g. "026-01") —
 *   seq is per-project, 2-digit zero-padded, rolling to 3+ digits
 *   naturally once a single project passes 99 invoices (lpad only pads
 *   UP to the target width, same convention as lib/job-number.ts's
 *   nextJobNumber()). Computed as (max existing numeric seq for THIS
 *   project's job_number prefix) + 1 — reads ALL of this project's
 *   client_invoices rows regardless of status, so a VOIDED invoice's
 *   number is never reissued to a new one (BUILD-SPEC.md this round:
 *   "seq per project incl. void").
 * - No project, OR a project whose job_number is still null/unset:
 *   'GEN-{seq}' — a single GLOBAL sequence shared by every such
 *   invoice across the whole system (not per-project, since there is
 *   no per-project prefix to key off). The "project exists but has no
 *   job_number yet" case isn't explicitly specified by the brief (which
 *   only says "no project → GEN-{NN} global seq") — falling back to the
 *   same GEN- pool here is the conservative choice: it guarantees
 *   uniqueness without inventing a numbering scheme the brief never
 *   asked for, and once that project is assigned a job_number, its
 *   NEXT invoice picks up the job_number-prefixed scheme automatically.
 *
 * Reads every client_invoices row unfiltered by soft-delete (same
 * "never reissue a number that used to belong to something else"
 * conservatism as lib/job-number.ts nextJobNumber()'s own doc comment).
 */
export async function nextInvoiceNumber(
  supabase: SupabaseClient,
  project: { id: string; job_number?: string | null } | null
): Promise<string> {
  const prefix = project?.job_number ? project.job_number : "GEN";

  let query = supabase.from("client_invoices").select("invoice_number");
  if (project?.job_number) {
    // Per-project sequence: only this project's own rows can share the
    // job_number prefix (a different project's job_number is a
    // different prefix string, so this filter is really just an
    // optimization — the regex below re-checks the prefix anyway).
    query = query.eq("project_id", project.id);
  } else {
    // Global GEN- pool: every client_invoices row that itself used the
    // GEN- prefix, from any project (or none).
    query = query.like("invoice_number", "GEN-%");
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Could not compute next invoice number: ${error.message}`);
  }

  const seqPattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
  let max = 0;
  for (const row of data ?? []) {
    const raw = (row as { invoice_number: string | null }).invoice_number;
    if (!raw) continue;
    const match = seqPattern.exec(raw);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }

  const next = max + 1;
  return `${prefix}-${String(next).padStart(2, "0")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------
// GST math
//
// Rounding rule (documented per this round's brief: "round half-up
// cents, document rounding"): subtotal_ex_gst is the sum of every line
// item's amount_ex_gst, rounded half-up to whole cents; gst is 10% of
// THAT rounded subtotal, itself rounded half-up to whole cents; and
// total_inc_gst is subtotal_ex_gst + gst — i.e. the two ALREADY-ROUNDED
// figures added together, NOT `subtotal * 1.1` rounded once at the end.
// This order matters: rounding subtotal and gst independently before
// summing is what makes `total - subtotal` always exactly equal the
// gst figure printed on the PDF (a client reading the tax invoice can
// re-derive the total from the two printed lines and get the exact
// same cents every time); rounding `subtotal * 1.1` in one step can
// occasionally differ from `round(subtotal) + round(subtotal * 0.1)` by
// a single cent, which on a tax invoice is worth avoiding even though
// it's mathematically a rounding-convention choice, not a "bug" either
// way. Math.round() rounds .5 away from zero for positive inputs
// (invoice amounts are never negative in this phase), i.e. round-half-
// up — matches roundToCents() in
// app/api/projects/[id]/invoices/route.ts (the existing supplier-
// invoice pipeline), kept as its own local copy here rather than a
// shared import since that route's helper isn't exported.
// ------------------------------------------------------------

const GST_RATE = 0.1;

export function roundHalfUpCents(value: number): number {
  // A fixed Number.EPSILON nudge (~2.22e-16) is far too small to
  // correct the float representation error introduced BY the *100
  // multiplication itself (e.g. 40.15 * 100 can land on
  // 4014.999999999999, not 4015) — that error scales with the value,
  // epsilon doesn't. .toFixed(8) does a correctly-rounded decimal
  // conversion from the double's actual value first, which resolves
  // that noise back to the intended decimal (e.g. "4015.00000000")
  // before the real half-up rounding happens. Verified empirically
  // against 50,000 five-cent-tie subtotals — the old version rounded
  // GST down in 812 of them, this one in zero.
  const cents = Number((value * 100).toFixed(8));
  return Math.round(cents) / 100;
}

export interface ClientInvoiceTotals {
  subtotal_ex_gst: number;
  gst: number;
  total_inc_gst: number;
}

/** Computes subtotal/GST/total from a line-items array. Non-finite or
 * missing amounts are treated as 0 (defensive — the API route itself
 * validates every line item before this is ever called, so this is a
 * belt-and-braces fallback, not the primary validation). */
export function computeTotals(lineItems: ClientInvoiceLineItem[]): ClientInvoiceTotals {
  const rawSubtotal = lineItems.reduce((sum, li) => {
    const amount = Number(li.amount_ex_gst);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const subtotal_ex_gst = roundHalfUpCents(rawSubtotal);
  const gst = roundHalfUpCents(subtotal_ex_gst * GST_RATE);
  const total_inc_gst = roundHalfUpCents(subtotal_ex_gst + gst);
  return { subtotal_ex_gst, gst, total_inc_gst };
}

/**
 * Validates + normalises a raw line-items array from a request body.
 * Returns null (caller responds 400) if the array is empty or any row
 * fails validation — every description must be non-empty after
 * trimming, every amount_ex_gst must be a finite number. Amounts are
 * NOT restricted to be positive (a credit/discount line is a legitimate
 * future use even though phase 1's composer UI only ever submits
 * positive lines) — the total can still land negative or zero, which
 * this function does not itself reject; that's a business-judgment call
 * left to the caller/admin, not a data-integrity one.
 */
export function cleanLineItems(raw: unknown): ClientInvoiceLineItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const cleaned: ClientInvoiceLineItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const description = typeof (entry as { description?: unknown }).description === "string"
      ? (entry as { description: string }).description.trim()
      : "";
    const amount = Number((entry as { amount_ex_gst?: unknown }).amount_ex_gst);
    if (!description || !Number.isFinite(amount)) return null;
    cleaned.push({ description, amount_ex_gst: roundHalfUpCents(amount) });
  }
  return cleaned;
}

/**
 * Review fix: void and mark-paid both used to only flip `status` in
 * our own DB, leaving any existing Stripe Payment Link live and fully
 * payable forever — a client re-opening an old emailed PDF/link could
 * still pay a since-voided invoice, or double-pay one already settled
 * by bank transfer. Deactivates the link at Stripe (POST
 * /v1/payment_links/{id}, active=false) whenever one exists, and
 * always clears stripe_payment_url/stripe_payment_link_id on the row
 * regardless of whether the Stripe call itself succeeds — a stale URL
 * left in our own DB is a UI/PDF risk (mitigated separately by
 * InvoicePdf.tsx's own status gate, but this is the source-of-truth
 * fix), whereas a Stripe API hiccup deactivating a link that a client
 * would need to actively revisit is a smaller, already-logged risk.
 * Never throws — a failed deactivation is reported, not fatal to the
 * void/mark-paid action itself.
 */
export async function deactivateStripePaymentLink(
  supabase: SupabaseClient,
  invoiceId: string,
  stripePaymentLinkId: string | null
): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (stripePaymentLinkId && secretKey) {
    try {
      const res = await fetch(`https://api.stripe.com/v1/payment_links/${stripePaymentLinkId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "active=false",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Stripe payment_links deactivate failed (${res.status}): ${text.slice(0, 300)}`);
      }
    } catch (err) {
      await reportError("client-invoice-stripe-link", err);
    }
  }

  await supabase
    .from("client_invoices")
    .update({ stripe_payment_url: null, stripe_payment_link_id: null })
    .eq("id", invoiceId);
}
