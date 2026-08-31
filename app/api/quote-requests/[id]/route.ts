import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { SupplierQuoteRequestStatus } from "@/types/supplier-quotes";

const STATUSES: SupplierQuoteRequestStatus[] = ["draft", "sent", "acknowledged", "quote_received", "declined", "selected", "closed"];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can update quote requests" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const { data: current } = await supabase.from("supplier_quote_requests").select("*").eq("id", id).maybeSingle();
  if (!current) return NextResponse.json({ error: "Quote request not found" }, { status: 404 });
  const patch: Record<string, unknown> = {};
  if (typeof body.promised_quote_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.promised_quote_at)) patch.promised_quote_at = body.promised_quote_at;
  if (body.promised_quote_at === null) patch.promised_quote_at = null;
  if (typeof body.quote_reference === "string" || body.quote_reference === null) patch.quote_reference = typeof body.quote_reference === "string" ? body.quote_reference.trim() || null : null;
  if (typeof body.response_note === "string" || body.response_note === null) patch.response_note = typeof body.response_note === "string" ? body.response_note.trim() || null : null;
  if (body.quote_amount_ex_gst === null) patch.quote_amount_ex_gst = null;
  if (typeof body.quote_amount_ex_gst === "number" && Number.isFinite(body.quote_amount_ex_gst) && body.quote_amount_ex_gst >= 0) patch.quote_amount_ex_gst = body.quote_amount_ex_gst;
  if (typeof body.status === "string" && STATUSES.includes(body.status as SupplierQuoteRequestStatus)) patch.status = body.status;
  if (patch.status === "quote_received" && !current.quote_received_at) patch.quote_received_at = new Date().toISOString();

  if (patch.status === "selected") {
    if (!["quote_received", "selected"].includes(current.status)) return NextResponse.json({ error: "Only a received quote can be selected" }, { status: 409 });
    const [{ data: responseLines }, { data: packageLines }] = await Promise.all([
      supabase.from("supplier_quote_response_lines").select("package_line_id,amount_ex_gst").eq("request_id", id),
      supabase.from("supplier_quote_package_lines").select("id,cost_line_id").eq("package_id", current.package_id),
    ]);
    const amountByPackageLine = new Map((responseLines ?? []).map((line) => [line.package_line_id, line.amount_ex_gst]));
    for (const line of packageLines ?? []) {
      const amount = amountByPackageLine.get(line.id);
      const linePatch: Record<string, unknown> = { quote_status: "Q", contact_id: current.contact_id };
      if (typeof amount === "number") linePatch.cost_ex_gst = amount;
      await supabase.from("cost_lines").update(linePatch).eq("id", line.cost_line_id);
    }
    await supabase.from("supplier_quote_requests").update({ status: "closed" }).eq("package_id", current.package_id).neq("id", id).not("status", "in", "(declined,closed)");
    await supabase.from("supplier_quote_packages").update({ status: "complete" }).eq("id", current.package_id);
  }

  const { data: updated, error } = await supabase.from("supplier_quote_requests").update(patch).eq("id", id).select().single();
  if (error || !updated) return NextResponse.json({ error: error?.message ?? "Could not update quote request" }, { status: 500 });
  return NextResponse.json({ request: updated });
}
