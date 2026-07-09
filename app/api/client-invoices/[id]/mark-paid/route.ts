import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { deactivateStripePaymentLink } from "@/lib/client-invoices";
import type { ClientInvoice } from "@/types/client-invoices";

export const runtime = "nodejs";

/**
 * POST /api/client-invoices/[id]/mark-paid
 * Admin-only. Body: none. Sets status='paid', paid_at=now(). MYOB
 * stays the ledger of record — this is a manual reconciliation marker
 * only (BUILD-SPEC.md DECISIONS: "MYOB stays, manual entry (no API
 * sync for now)"), not a payment-verification integration. Allowed
 * from 'sent' (the normal path) or 'draft' (an admin recording a cash/
 * in-person payment for an invoice never formally emailed) — rejected
 * only for an already-'paid' or 'void' invoice (400), both terminal.
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
    return NextResponse.json({ error: "Only admins can mark client invoices paid" }, { status: 403 });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("client_invoices")
    .select("id,status,stripe_payment_link_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (existing.status === "paid" || existing.status === "void") {
    return NextResponse.json(
      { error: `Invoice is already ${existing.status} — no change made` },
      { status: 400 }
    );
  }

  const { data: invoice, error } = await supabase
    .from("client_invoices")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Once marked paid (e.g. reconciled against a bank transfer), any
  // live Stripe link must not stay payable — otherwise a client could
  // pay a second time. See lib/client-invoices.ts's
  // deactivateStripePaymentLink() for why this needs a real API call,
  // not just a local status flip.
  await deactivateStripePaymentLink(supabase, id, existing.stripe_payment_link_id ?? null);

  return NextResponse.json({
    invoice: { ...invoice, stripe_payment_url: null, stripe_payment_link_id: null } as ClientInvoice,
  });
}
