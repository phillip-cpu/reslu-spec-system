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

  if (body.response_lines !== undefined) {
    if (!Array.isArray(body.response_lines)) {
      return NextResponse.json({ error: "response_lines must be an array" }, { status: 400 });
    }
    const { data: packageLines, error: packageLineError } = await supabase
      .from("supplier_quote_package_lines")
      .select("id")
      .eq("package_id", current.package_id);
    if (packageLineError) return NextResponse.json({ error: packageLineError.message }, { status: 500 });
    const allowedIds = new Set((packageLines ?? []).map((line) => line.id));
    const seenIds = new Set<string>();
    const responseLines: { request_id: string; package_line_id: string; amount_ex_gst: number | null; note: string | null }[] = [];
    for (const candidate of body.response_lines) {
      if (!candidate || typeof candidate !== "object") {
        return NextResponse.json({ error: "Every response line must be an object" }, { status: 400 });
      }
      const line = candidate as Record<string, unknown>;
      const packageLineId = typeof line.package_line_id === "string" ? line.package_line_id : "";
      const amount = line.amount_ex_gst;
      if (!allowedIds.has(packageLineId) || seenIds.has(packageLineId)) {
        return NextResponse.json({ error: "One or more quote lines are invalid or duplicated" }, { status: 400 });
      }
      if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
        return NextResponse.json({ error: "Quote line amounts must be non-negative numbers" }, { status: 400 });
      }
      seenIds.add(packageLineId);
      responseLines.push({
        request_id: id,
        package_line_id: packageLineId,
        amount_ex_gst: amount as number | null,
        note: typeof line.note === "string" ? line.note.trim() || null : null,
      });
    }
    if (responseLines.length > 0) {
      const { error: responseLineError } = await supabase
        .from("supplier_quote_response_lines")
        .upsert(responseLines, { onConflict: "request_id,package_line_id" });
      if (responseLineError) return NextResponse.json({ error: responseLineError.message }, { status: 500 });
    }
  }

  if (body.response_items !== undefined) {
    if (!Array.isArray(body.response_items)) {
      return NextResponse.json({ error: "response_items must be an array" }, { status: 400 });
    }
    const { data: packageItems, error: packageItemError } = await supabase
      .from("supplier_quote_package_items")
      .select("id")
      .eq("package_id", current.package_id);
    if (packageItemError) return NextResponse.json({ error: packageItemError.message }, { status: 500 });
    const allowedIds = new Set((packageItems ?? []).map((item) => item.id));
    const seenIds = new Set<string>();
    const responseItems: { request_id: string; package_item_id: string; amount_ex_gst: number | null; note: string | null }[] = [];
    for (const candidate of body.response_items) {
      if (!candidate || typeof candidate !== "object") {
        return NextResponse.json({ error: "Every FF&E response item must be an object" }, { status: 400 });
      }
      const item = candidate as Record<string, unknown>;
      const packageItemId = typeof item.package_item_id === "string" ? item.package_item_id : "";
      const amount = item.amount_ex_gst;
      if (!allowedIds.has(packageItemId) || seenIds.has(packageItemId)) {
        return NextResponse.json({ error: "One or more FF&E quote items are invalid or duplicated" }, { status: 400 });
      }
      if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
        return NextResponse.json({ error: "FF&E quote amounts must be non-negative numbers" }, { status: 400 });
      }
      seenIds.add(packageItemId);
      responseItems.push({
        request_id: id,
        package_item_id: packageItemId,
        amount_ex_gst: amount as number | null,
        note: typeof item.note === "string" ? item.note.trim() || null : null,
      });
    }
    if (responseItems.length > 0) {
      const { error: responseItemError } = await supabase
        .from("supplier_quote_response_items")
        .upsert(responseItems, { onConflict: "request_id,package_item_id" });
      if (responseItemError) return NextResponse.json({ error: responseItemError.message }, { status: 500 });
    }
  }

  if (body.response_lines !== undefined || body.response_items !== undefined) {
    const [{ data: allResponseLines, error: responseLineReadError }, { data: allResponseItems, error: responseItemReadError }] = await Promise.all([
      supabase.from("supplier_quote_response_lines").select("amount_ex_gst").eq("request_id", id),
      supabase.from("supplier_quote_response_items").select("amount_ex_gst").eq("request_id", id),
    ]);
    const responseReadError = responseLineReadError ?? responseItemReadError;
    if (responseReadError) return NextResponse.json({ error: responseReadError.message }, { status: 500 });
    const amounts = [...(allResponseLines ?? []), ...(allResponseItems ?? [])]
      .map((row) => row.amount_ex_gst)
      .filter((amount): amount is number => typeof amount === "number");
    patch.quote_amount_ex_gst = amounts.length > 0 ? amounts.reduce((sum, amount) => sum + amount, 0) : null;
  }

  if (patch.status === "selected") {
    const { data: selected, error: selectError } = await supabase.rpc("select_supplier_quote", { p_request_id: id });
    if (selectError) return NextResponse.json({ error: selectError.message }, { status: 409 });
    return NextResponse.json({ request: selected });
  }

  const { data: updated, error } = await supabase.from("supplier_quote_requests").update(patch).eq("id", id).select().single();
  if (error || !updated) return NextResponse.json({ error: error?.message ?? "Could not update quote request" }, { status: 500 });
  if (patch.status === "quote_received") {
    const { data: linkedLines } = await supabase
      .from("supplier_quote_package_lines")
      .select("cost_line_id")
      .eq("package_id", current.package_id);
    if (linkedLines?.length) {
      await supabase.from("cost_lines").update({ quote_status: "Q" }).in("id", linkedLines.map((line) => line.cost_line_id));
    }
  }
  return NextResponse.json({ request: updated });
}
