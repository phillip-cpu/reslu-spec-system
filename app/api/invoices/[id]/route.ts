import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { validateInvoiceAllocations } from "@/lib/invoice-allocations";
import type { InvoiceMatchType } from "@/types";
import type { InvoiceWithAllocations, InvoiceWithIntake } from "@/types/round-supplier-invoice-intake";

export const runtime = "nodejs";

const MATCH_TYPES: InvoiceMatchType[] = ["cost_line", "item"];

const EDITABLE_FIELDS = new Set([
  "supplier",
  "invoice_number",
  "invoice_date",
  "amount_ex_gst",
  "gst",
  "total",
  "confidence_note",
]);

const NUMERIC_FIELDS = new Set(["amount_ex_gst", "gst", "total"]);

/**
 * PATCH /api/invoices/[id]
 * General field update PLUS the "propose a match" action: setting
 * `proposed_match_type`/`proposed_match_id` together also flips status
 * to 'proposed' (BUILD-SPEC.md "Invoice pipeline": "Aria extracts ...
 * proposes match ... lands in Invoices queue"). Clearing the match
 * (both null) drops status back to 'unmatched' if it was 'proposed'
 * (does not touch 'approved'/'rejected' — those are terminal states
 * changed only via the approve/reject routes).
 *
 * Admin-only, financial — whole-route 403 like the estimate module.
 */
export async function PATCH(
  request: NextRequest,
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
      { error: "Only admins can update invoices" },
      { status: 403 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("invoices")
    .select("*, invoice_allocations(id)")
    .eq("id", id)
    .single();
  if (fetchError || !existing) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (existing.status === "approved" || existing.status === "rejected") {
    return NextResponse.json(
      { error: `Cannot edit an invoice that is already ${existing.status}` },
      { status: 400 }
    );
  }

  if (Object.prototype.hasOwnProperty.call(body, "allocations")) {
    if (Object.keys(body).some((key) => key !== "allocations")) {
      return NextResponse.json(
        { error: "Save invoice fields and allocations separately" },
        { status: 400 }
      );
    }

    const validation = validateInvoiceAllocations(body.allocations, Number(existing.amount_ex_gst), {
      allowEmpty: true,
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { error: allocationError } = await supabase.rpc("set_supplier_invoice_allocations", {
      p_invoice_id: id,
      p_allocations: validation.allocations,
    });
    if (allocationError) {
      return NextResponse.json({ error: allocationError.message }, { status: 400 });
    }

    const { data: invoice, error: reloadError } = await supabase
      .from("invoices")
      .select("*, invoice_allocations(*)")
      .eq("id", id)
      .single();
    if (reloadError || !invoice) {
      return NextResponse.json({ error: reloadError?.message ?? "Invoice not found" }, { status: 500 });
    }
    const typed = invoice as unknown as InvoiceWithAllocations;
    typed.invoice_allocations = [...(typed.invoice_allocations ?? [])].sort(
      (a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)
    );
    return NextResponse.json({ invoice: typed });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (NUMERIC_FIELDS.has(key)) {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ error: `${key} must be a number` }, { status: 400 });
      }
      update[key] = n;
    } else if (typeof raw === "string") {
      update[key] = raw.trim() === "" ? null : raw.trim();
    } else {
      update[key] = raw;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(update, "amount_ex_gst") &&
    existing.invoice_allocations.length > 0 &&
    Number(update.amount_ex_gst) !== Number(existing.amount_ex_gst)
  ) {
    return NextResponse.json(
      { error: "Clear the saved allocations before changing the invoice amount" },
      { status: 400 }
    );
  }

  const hasMatchType = "proposed_match_type" in body;
  const hasMatchId = "proposed_match_id" in body;
  if (hasMatchType || hasMatchId) {
    const matchType = body.proposed_match_type;
    const matchId = body.proposed_match_id;

    if (matchType === null && matchId === null) {
      update.proposed_match_type = null;
      update.proposed_match_id = null;
      if (existing.status === "proposed") {
        update.status = "unmatched";
      }
    } else {
      if (typeof matchType !== "string" || !MATCH_TYPES.includes(matchType as InvoiceMatchType)) {
        return NextResponse.json({ error: "Invalid proposed_match_type" }, { status: 400 });
      }
      if (typeof matchId !== "string" || !matchId) {
        return NextResponse.json({ error: "proposed_match_id is required" }, { status: 400 });
      }

      // Validate the target exists (no FK possible since proposed_match_id
      // can point at cost_lines or items depending on type — see
      // 007_estimating.sql's comment on this column).
      const table = matchType === "cost_line" ? "cost_lines" : "items";
      const { data: target } = await supabase
        .from(table)
        .select("id, project_id")
        .eq("id", matchId)
        .maybeSingle();
      if (!target || target.project_id !== existing.project_id) {
        return NextResponse.json(
          { error: "Match target not found in this project" },
          { status: 400 }
        );
      }

      update.proposed_match_type = matchType;
      update.proposed_match_id = matchId;
      update.status = "proposed";
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No editable fields in request" }, { status: 400 });
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ invoice: invoice as InvoiceWithIntake });
}
