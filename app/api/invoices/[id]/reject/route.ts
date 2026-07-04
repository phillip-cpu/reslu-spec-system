import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { Invoice } from "@/types";

export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/reject
 * Sets status='rejected'. No financial writes anywhere — rejecting
 * never touches a cost_line or item (mirrors approve's cost_line write
 * existing only on the approve path). A rejected invoice drops out of
 * the unique (project, supplier, invoice_number) index's scope
 * (007_estimating.sql: `where status != 'rejected'`), so the same
 * supplier+number can be resubmitted cleanly via a fresh POST
 * /api/projects/[id]/invoices.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can reject invoices" },
      { status: 403 }
    );
  }

  const { data: existing, error: fetchError } = await supabase
    .from("invoices")
    .select("id, status")
    .eq("id", id)
    .single();
  if (fetchError || !existing) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (existing.status === "approved") {
    return NextResponse.json(
      { error: "Cannot reject an already-approved invoice" },
      { status: 400 }
    );
  }
  if (existing.status === "rejected") {
    return NextResponse.json({ error: "Invoice is already rejected" }, { status: 400 });
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .update({ status: "rejected" })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ invoice: invoice as Invoice });
}
