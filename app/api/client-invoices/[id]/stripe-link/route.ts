import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { reportError } from "@/lib/report-error";
import type { ClientInvoice } from "@/types/client-invoices";

export const runtime = "nodejs";

/**
 * POST /api/client-invoices/[id]/stripe-link
 * Admin-only, explicit action (BUILD-SPEC.md this round: "NEVER
 * auto-create; explicit action" — never called automatically on
 * create/send). Body: none. Requires STRIPE_SECRET_KEY (503 + no
 * button surfaced in the UI when unset — see
 * components/settings/IntegrationStatus-style note in Settings). Plain
 * fetch to Stripe's REST API (BUILD-SPEC.md decision, same "no SDK
 * dependency" posture as lib/resend.ts) — POST /v1/payment_links,
 * form-encoded body, one ad-hoc price_data line item for the invoice's
 * full total_inc_gst (Stripe AU: card + BECS debit both flow through
 * this same Payment Link automatically — no extra config needed here).
 * On success, stores the returned `url` on stripe_payment_url — this is
 * what flips the PDF/email's "Pay online" button on (see
 * components/pdf/InvoicePdf.tsx). BUILD-SPEC.md DECISIONS: "optional
 * Stripe payment link per invoice for small invoices" — intended for
 * design-fee-sized amounts, not construction-sized ones (bank transfer
 * is the standard path; see lib/bank-details.ts).
 *
 * Stripe account setup itself (creating the account, obtaining the
 * secret key) is Phillip's own task, never automated here — BUILD-
 * SPEC.md this round: "Stripe account setup is Phillip's task (never
 * Claude's/Aria's — financial account)".
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can create a Stripe payment link" }, { status: 403 });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json(
      { error: "Stripe is not configured — set STRIPE_SECRET_KEY to enable payment links" },
      { status: 503 }
    );
  }

  const { data: invoice, error: fetchError } = await supabase
    .from("client_invoices")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  const typedInvoice = invoice as ClientInvoice;
  if (typedInvoice.status === "void" || typedInvoice.status === "paid") {
    return NextResponse.json(
      { error: `Cannot create a payment link for a ${typedInvoice.status} invoice` },
      { status: 400 }
    );
  }

  // Stripe amounts are in the currency's smallest unit (cents for AUD).
  // total_inc_gst is already rounded to whole cents (lib/client-invoices.ts
  // computeTotals()) — the extra Math.round guards only against float
  // drift from the *100 multiplication itself, never a real rounding
  // decision here.
  const unitAmountCents = Math.round(typedInvoice.total_inc_gst * 100);
  if (!Number.isFinite(unitAmountCents) || unitAmountCents <= 0) {
    return NextResponse.json({ error: "Invoice total must be greater than zero" }, { status: 400 });
  }

  const body = new URLSearchParams();
  body.set("line_items[0][price_data][currency]", "aud");
  body.set("line_items[0][price_data][product_data][name]", `RESLU invoice ${typedInvoice.invoice_number}`);
  body.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
  body.set("line_items[0][quantity]", "1");

  let stripeUrl: string;
  let stripeLinkId: string | null = null;
  try {
    const res = await fetch("https://api.stripe.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Stripe payment_links failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { url?: string; id?: string };
    if (!json.url) {
      throw new Error("Stripe response had no url");
    }
    stripeUrl = json.url;
    stripeLinkId = json.id ?? null;
  } catch (err) {
    await reportError("client-invoice-stripe-link", err);
    return NextResponse.json({ error: "Could not create Stripe payment link" }, { status: 502 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("client_invoices")
    // stripe_payment_link_id (the plink_... id, distinct from the
    // public url) is what lets void/mark-paid actually deactivate this
    // link later via the Stripe API — see those routes' own comments.
    .update({ stripe_payment_url: stripeUrl, stripe_payment_link_id: stripeLinkId })
    .eq("id", id)
    .select()
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ invoice: updated as ClientInvoice });
}
