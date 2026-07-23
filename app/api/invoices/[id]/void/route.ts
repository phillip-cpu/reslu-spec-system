import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { InvoiceWithIntake } from "@/types/round-supplier-invoice-intake";

export const runtime = "nodejs";

/** Voids an invoice and atomically reverses any approved allocations. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can void invoices" }, { status: 403 });
  }

  let reason = "Voided by admin";
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      const body = JSON.parse(rawBody) as { reason?: unknown };
      if (typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim();
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const { data: invoice, error } = await supabase.rpc("void_supplier_invoice", {
    p_invoice_id: id,
    p_voided_by: info.userId,
    p_reason: reason,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ invoice: invoice as InvoiceWithIntake });
}
