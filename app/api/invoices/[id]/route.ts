import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { validateInvoiceAllocations } from "@/lib/invoice-allocations";
import { DUPLICATE_INVOICE_MESSAGE } from "@/lib/invoice-duplicates";
import { saveInvoiceDeliveryItemLinks } from "@/lib/invoice-delivery-links";
import type { InvoiceMatchType } from "@/types";
import type { InvoiceWithAllocations, InvoiceWithIntake } from "@/types/round-supplier-invoice-intake";

export const runtime = "nodejs";

const MATCH_TYPES: InvoiceMatchType[] = ["cost_line", "item", "item_component"];

const EDITABLE_FIELDS = new Set([
  "supplier",
  "invoice_number",
  "invoice_date",
  "due_date",
  "amount_ex_gst",
  "gst",
  "total",
  "confidence_note",
  "payment_status",
  "amount_paid",
  "paid_at",
]);

const CASH_FIELDS = new Set(["due_date", "payment_status", "amount_paid", "paid_at"]);
const NUMERIC_FIELDS = new Set(["amount_ex_gst", "gst", "total", "amount_paid"]);
const PAYMENT_STATUSES = new Set(["unpaid", "part_paid", "paid"]);

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

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
    .select("*, invoice_allocations(id), supplier_invoice_lines(id)")
    .eq("id", id)
    .single();
  if (fetchError || !existing) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  const requestedKeys = Object.keys(body);
  const cashOnlyUpdate = requestedKeys.length > 0 && requestedKeys.every((key) => CASH_FIELDS.has(key));
  if (
    existing.status === "rejected" ||
    existing.status === "voided" ||
    (existing.status === "approved" && !cashOnlyUpdate)
  ) {
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

    const deliveryLinks = await saveInvoiceDeliveryItemLinks(
      supabase,
      id,
      existing.project_id,
      validation.allocations
    );
    if (deliveryLinks.error) {
      return NextResponse.json({ error: deliveryLinks.error }, { status: 400 });
    }

    const { data: invoice, error: reloadError } = await supabase
      .from("invoices")
      .select("*, invoice_allocations(*, invoice_allocation_delivery_items(item_id)), supplier_invoice_lines(*)")
      .eq("id", id)
      .single();
    if (reloadError || !invoice) {
      return NextResponse.json({ error: reloadError?.message ?? "Invoice not found" }, { status: 500 });
    }
    const typed = invoice as unknown as InvoiceWithAllocations;
    typed.invoice_allocations = [...(typed.invoice_allocations ?? [])].sort(
      (a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)
    );
    typed.supplier_invoice_lines = [...(typed.supplier_invoice_lines ?? [])].sort(
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

  for (const field of ["due_date", "paid_at"] as const) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) continue;
    if (update[field] !== null && !validDate(update[field])) {
      return NextResponse.json({ error: `${field} must be an ISO calendar date or null` }, { status: 400 });
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(update, "payment_status") &&
    !PAYMENT_STATUSES.has(String(update.payment_status))
  ) {
    return NextResponse.json({ error: "Invalid payment_status" }, { status: 400 });
  }

  if (cashOnlyUpdate || requestedKeys.some((key) => CASH_FIELDS.has(key))) {
    const paymentStatus = String(update.payment_status ?? existing.payment_status ?? "unpaid");
    const amountPaid = Number(update.amount_paid ?? existing.amount_paid ?? 0);
    const paidAt = Object.prototype.hasOwnProperty.call(update, "paid_at")
      ? update.paid_at
      : existing.paid_at;
    const total = Number(existing.total);
    if (!Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > total) {
      return NextResponse.json({ error: "amount_paid must be between zero and the invoice total" }, { status: 400 });
    }
    const coherent =
      (paymentStatus === "unpaid" && amountPaid === 0 && paidAt === null) ||
      (paymentStatus === "part_paid" && amountPaid > 0 && amountPaid < total && validDate(paidAt)) ||
      (paymentStatus === "paid" && amountPaid === total && validDate(paidAt));
    if (!coherent) {
      return NextResponse.json(
        { error: "Payment status, gross amount paid and payment date are inconsistent" },
        { status: 400 }
      );
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(update, "amount_ex_gst") &&
    (existing.invoice_allocations.length > 0 || existing.supplier_invoice_lines.length > 0) &&
    Number(update.amount_ex_gst) !== Number(existing.amount_ex_gst)
  ) {
    return NextResponse.json(
      { error: "Clear saved allocations and supplier lines before changing the invoice amount" },
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
      let targetProjectId: string | null = null;
      if (matchType === "item_component") {
        const { data: target } = await supabase
          .from("item_components")
          .select("items!inner(project_id)")
          .eq("id", matchId)
          .is("deleted_at", null)
          .maybeSingle();
        const linkedItem = target?.items as unknown as { project_id: string } | null;
        targetProjectId = linkedItem?.project_id ?? null;
      } else {
        const table = matchType === "cost_line" ? "cost_lines" : "items";
        const { data: target } = await supabase
          .from(table)
          .select("id, project_id")
          .eq("id", matchId)
          .maybeSingle();
        targetProjectId = target?.project_id ?? null;
      }
      if (targetProjectId !== existing.project_id) {
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

  if (
    Object.prototype.hasOwnProperty.call(update, "invoice_number") ||
    Object.prototype.hasOwnProperty.call(update, "invoice_date") ||
    Object.prototype.hasOwnProperty.call(update, "amount_ex_gst")
  ) {
    const { data: duplicateInvoiceId, error: duplicateCheckError } = await supabase.rpc(
      "find_live_invoice_duplicate",
      {
        p_project_id: existing.project_id,
        p_invoice_number: update.invoice_number ?? existing.invoice_number,
        p_amount_ex_gst: update.amount_ex_gst ?? existing.amount_ex_gst,
        p_invoice_date: Object.prototype.hasOwnProperty.call(update, "invoice_date")
          ? update.invoice_date
          : existing.invoice_date,
        p_exclude_id: id,
      }
    );
    if (duplicateCheckError) {
      return NextResponse.json({ error: duplicateCheckError.message }, { status: 500 });
    }
    if (duplicateInvoiceId) {
      return NextResponse.json(
        {
          error: DUPLICATE_INVOICE_MESSAGE,
          duplicate_invoice_id: duplicateInvoiceId,
        },
        { status: 409 }
      );
    }
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: DUPLICATE_INVOICE_MESSAGE }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ invoice: invoice as InvoiceWithIntake });
}
