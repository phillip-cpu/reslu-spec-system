import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { deactivateStripePaymentLink } from "@/lib/client-invoices";
import type { ClientInvoice } from "@/types/client-invoices";

export const runtime = "nodejs";

/**
 * POST /api/client-invoices/[id]/void
 * Admin-only. Body: none. Sets status='void' — a terminal state, same
 * "no undo" posture as the existing supplier invoices queue's reject
 * action, except a void invoice's NUMBER is never reissued (see
 * lib/client-invoices.ts nextInvoiceNumber()'s "seq per project incl.
 * void" doc comment) — voiding is the correct way to kill a
 * mis-entered invoice without ever letting a second, different invoice
 * carry the same invoice_number a client may already have on file.
 * Rejected for an already-'paid' or already-'void' invoice (400).
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
    return NextResponse.json({ error: "Only admins can void client invoices" }, { status: 403 });
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
      { error: `Invoice is already ${existing.status} — cannot void` },
      { status: 400 }
    );
  }

  const { data: invoice, error } = await supabase
    .from("client_invoices")
    .update({ status: "void" })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // A voided invoice must not stay payable at a still-live Stripe link
  // — see lib/client-invoices.ts's deactivateStripePaymentLink() for
  // why this can't just be a local status flip.
  await deactivateStripePaymentLink(supabase, id, existing.stripe_payment_link_id ?? null);

  return NextResponse.json({
    invoice: { ...invoice, stripe_payment_url: null, stripe_payment_link_id: null } as ClientInvoice,
  });
}
