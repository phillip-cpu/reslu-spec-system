import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { Invoice } from "@/types";

export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/approve
 * BUILD-SPEC.md "Invoice pipeline — AI-updated actuals": "admin
 * one-click approves → actual_paid updates on matched line, variance
 * recalculates, PDF stays attached as evidence." Rules: "AI proposes,
 * admin approves — no silent money writes v1."
 *
 * Approve sets status='approved', approved_by/approved_at, THEN:
 *
 *  - cost_line match: ADDS amount_ex_gst to the line's existing
 *    actual_paid_ex_gst (COALESCE(existing, 0) + amount_ex_gst) rather
 *    than overwriting it — this is what makes partial invoices work
 *    (e.g. a 50% deposit invoice approved now, the balance invoice
 *    approved later; overwriting would lose the first payment).
 *    lineVariance() in lib/estimate.ts recomputes on next read from
 *    this updated actual_paid_ex_gst, so "variance recalculates" falls
 *    out of the existing rollup math for free — no separate variance
 *    column to maintain.
 *
 *  - item match: deliberately does NOT write price_trade (or anything
 *    else) on the item. Only the linkage (this invoice's
 *    proposed_match_type/id, already set by the propose step) is
 *    preserved as the audit trail. Reasoning: price_trade represents
 *    the NEGOTIATED unit price the item was quoted at — it is captured
 *    once (typically from a quote, via the scraper/library trade-price
 *    flow) and is not the same figure as "amount this specific invoice
 *    paid" (an invoice could cover partial quantity, freight, multiple
 *    items, etc., none of which map 1:1 onto a single item's per-unit
 *    price_trade). Item-level actuals are intentionally routed through
 *    cost_lines (which DO have an actual_paid_ex_gst designed exactly
 *    for this), not by mutating the spec register's pricing fields as
 *    a side effect of invoice approval. An admin who wants an item's
 *    price_trade to reflect what was actually paid still does that
 *    explicitly via PATCH /api/items/[id], same as any other pricing
 *    edit — approval never silently rewrites it.
 *
 * "Transaction-ish": Supabase JS has no multi-statement transaction
 * API available here, so this does the invoice update first (the
 * authoritative "this invoice is approved" fact), then the cost_line
 * update. If the second write fails, the invoice is already approved
 * but the cost_line wasn't credited — surfaced as a 500 with a message
 * telling the admin to retry manually (re-running approve on an
 * already-approved invoice is rejected below, so a clean retry route
 * doesn't exist yet; this is flagged as a known follow-up rather than
 * silently swallowed).
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
      { error: "Only admins can approve invoices" },
      { status: 403 }
    );
  }

  const { data: existing, error: fetchError } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchError || !existing) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (existing.status === "approved") {
    return NextResponse.json({ error: "Invoice is already approved" }, { status: 400 });
  }
  if (existing.status === "rejected") {
    return NextResponse.json({ error: "Cannot approve a rejected invoice" }, { status: 400 });
  }
  if (!existing.proposed_match_type || !existing.proposed_match_id) {
    return NextResponse.json(
      { error: "Invoice has no proposed match to approve — set a match first" },
      { status: 400 }
    );
  }

  const { data: invoice, error: approveError } = await supabase
    .from("invoices")
    .update({
      status: "approved",
      approved_by: info.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (approveError) {
    return NextResponse.json({ error: approveError.message }, { status: 500 });
  }

  const typedInvoice = invoice as Invoice;

  if (typedInvoice.proposed_match_type === "cost_line") {
    const { data: line, error: lineFetchError } = await supabase
      .from("cost_lines")
      .select("id, actual_paid_ex_gst")
      .eq("id", typedInvoice.proposed_match_id)
      .single();

    if (lineFetchError || !line) {
      return NextResponse.json(
        {
          invoice: typedInvoice,
          warning:
            "Invoice approved, but its matched cost line could not be found — actuals were not updated.",
        },
        { status: 207 }
      );
    }

    const nextActual = roundToCents((line.actual_paid_ex_gst ?? 0) + typedInvoice.amount_ex_gst);

    const { error: lineUpdateError } = await supabase
      .from("cost_lines")
      .update({ actual_paid_ex_gst: nextActual })
      .eq("id", line.id);

    if (lineUpdateError) {
      return NextResponse.json(
        {
          invoice: typedInvoice,
          warning: `Invoice approved, but updating the cost line failed: ${lineUpdateError.message}`,
        },
        { status: 207 }
      );
    }
  }
  // item match: no automatic write — see the file-level comment above.

  return NextResponse.json({ invoice: typedInvoice });
}

function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
