import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { cleanLineItems, computeTotals } from "@/lib/client-invoices";
import type { ClientInvoice, ClientInvoiceKind, PatchClientInvoiceInput } from "@/types/client-invoices";

export const runtime = "nodejs";

const KINDS: ClientInvoiceKind[] = ["design_fee", "other"];

/**
 * GET /api/client-invoices/[id]
 * Admin-only. Response: { invoice }. Single-record read backing the
 * composer's edit view / action buttons (the list itself comes from
 * GET /api/projects/[id]/client-invoices).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access client invoices" }, { status: 403 });
  }

  const { data: invoice, error } = await supabase
    .from("client_invoices")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  return NextResponse.json({ invoice: invoice as ClientInvoice });
}

/**
 * PATCH /api/client-invoices/[id]
 * Admin-only. Body: PatchClientInvoiceInput — any of { kind?,
 * client_name?, client_email?, address?, line_items?, due_days?,
 * notes? }. ONLY permitted while status = 'draft' (400 otherwise) — a
 * tax invoice's figures must be frozen the moment it's sent (migration
 * 046's own column comments); reissuing corrected figures after send
 * means voiding this one and creating a fresh invoice, not editing this
 * row in place. Recomputes subtotal/gst/total server-side whenever
 * line_items is present in the body — never accepted from the client.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit client invoices" }, { status: 403 });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("client_invoices")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (existing.status !== "draft") {
    return NextResponse.json(
      { error: "Only a draft invoice can be edited — void it and raise a new one instead." },
      { status: 400 }
    );
  }

  let body: PatchClientInvoiceInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) {
      return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
    }
    update.kind = body.kind;
  }
  if (body.client_name !== undefined) {
    const trimmed = body.client_name.trim();
    if (!trimmed) return NextResponse.json({ error: "client_name cannot be blank" }, { status: 400 });
    update.client_name = trimmed;
  }
  if (body.client_email !== undefined) {
    update.client_email = body.client_email && body.client_email.trim() ? body.client_email.trim() : null;
  }
  if (body.address !== undefined) {
    update.address = body.address && body.address.trim() ? body.address.trim() : null;
  }
  if (body.notes !== undefined) {
    update.notes = body.notes && body.notes.trim() ? body.notes.trim() : null;
  }
  if (body.due_days !== undefined) {
    if (!Number.isFinite(Number(body.due_days))) {
      return NextResponse.json({ error: "due_days must be a number" }, { status: 400 });
    }
    update.due_days = Math.max(0, Math.trunc(Number(body.due_days)));
  }
  if (body.line_items !== undefined) {
    const cleaned = cleanLineItems(body.line_items);
    if (!cleaned) {
      return NextResponse.json(
        { error: "line_items must be a non-empty array of { description, amount_ex_gst }" },
        { status: 400 }
      );
    }
    const totals = computeTotals(cleaned);
    update.line_items = cleaned;
    update.subtotal_ex_gst = totals.subtotal_ex_gst;
    update.gst = totals.gst;
    update.total_inc_gst = totals.total_inc_gst;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ invoice: existing as ClientInvoice });
  }

  const { data: invoice, error: updateError } = await supabase
    .from("client_invoices")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ invoice: invoice as ClientInvoice });
}
