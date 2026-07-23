import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { closeBriefItem } from "@/lib/daily-brief-close";
import type {
  ApproveInvoiceInput,
  ApproveInvoiceResponse,
  InvoiceWithAllocations,
  InvoiceWithIntake,
} from "@/types/round-supplier-invoice-intake";

export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/approve
 * BUILD-SPEC.md "Invoice pipeline — AI-updated actuals": "admin
 * one-click approves → actual_paid updates on matched line, variance
 * recalculates, PDF stays attached as evidence." Rules: "AI proposes,
 * admin approves — no silent money writes v1." Body is OPTIONAL
 * (ApproveInvoiceInput, r24 addition) — every call site pre-r24 sends
 * none, which is still valid (an empty/missing JSON body is treated
 * the same as `{}`).
 *
 * Approve sets status='approved', approved_by/approved_at, THEN, per
 * the invoice's proposed_match_type — resolving `affectedItem` (the
 * items row whose cost is being confirmed, used for BOTH halves below):
 *
 *  - cost_line match: ADDS amount_ex_gst to the line's existing
 *    actual_paid_ex_gst (COALESCE(existing, 0) + amount_ex_gst) rather
 *    than overwriting it — this is what makes partial invoices work
 *    (e.g. a 50% deposit invoice approved now, the balance invoice
 *    approved later; overwriting would lose the first payment).
 *    lineVariance() in lib/estimate.ts recomputes on next read from
 *    this updated actual_paid_ex_gst, so "variance recalculates" falls
 *    out of the existing rollup math for free — no separate variance
 *    column to maintain. `affectedItem` is the cost line's own item_id,
 *    when set (a cost line isn't required to link to a spec item).
 *
 *  - item match (BOOKING SELECTION V2 + ARIA SUPPLIER INVOICES, r24,
 *    item 7 — REVERSES the pre-r24 "deliberately does NOT write
 *    anything on the item" behaviour, which routed ALL item-level
 *    actuals through cost_lines only): the matched item's OWN
 *    confirmed-cost field is still `cost_lines.actual_paid_ex_gst`
 *    (items themselves carry no actual-cost column of their own — see
 *    types/index.ts's Item interface, unchanged/protected this round —
 *    cost_lines.actual_paid_ex_gst IS "the item's real actual/confirmed
 *    cost field", exactly as the pre-r24 version of this comment
 *    described it, just now ALSO reachable when the invoice was matched
 *    directly to the item rather than to a cost line). Looked up via
 *    cost_lines.item_id = the matched item's id:
 *      - exactly one linked cost line -> same additive update as the
 *        cost_line-match branch above.
 *      - zero linked cost lines -> 207 warning, no write (nothing to
 *        credit against).
 *      - more than one linked cost line -> 207 warning, no write
 *        (ambiguous which line the payment applies to — safer to ask
 *        an admin to apply it manually via PATCH /api/estimate/lines/[id]
 *        than to guess and silently misattribute a real payment).
 *
 *  - EITHER match type, THEN (r24 item 7's second half): if
 *    `affectedItem.library_item_id` is set AND `apply_to_library_cost`
 *    (body, default true when library_item_id is set, false otherwise)
 *    is true, ALSO writes `library_items.price_trade` (unit cost =
 *    amount_ex_gst / item.quantity, rounded to cents — quantity<=0
 *    treated as 1) + `trade_price_received_at` (now) +
 *    `trade_price_source` (`Invoice {number} · {supplier}`) — the SAME
 *    three fields PATCH /api/library/[id] already writes for a manual
 *    trade-price entry (see that route's own FINANCIAL_EDITABLE set),
 *    so "future quotes use real numbers" falls out of the library's
 *    existing price_trade-is-the-quoted-figure convention for free.
 *    `invoices.library_cost_applied` (migration 052) is set true when
 *    this write happens — documented exactly in docs/API.md.
 *
 * Admin-only, server-side gated (whole-route 403 below) — the ONLY
 * place any of this ever runs from is a human's explicit Approve click
 * in the queue UI (or an equivalent authenticated admin API call);
 * nothing in the Aria pipeline (MCP propose_supplier_invoice, the email
 * pipeline that feeds it) can reach this route on its own.
 *
 * IDEMPOTENT: re-running approve on an already-approved invoice 400s
 * immediately, before any of the above runs — see the status check
 * below — so a retried/duplicate approve click can never double-credit
 * a cost line or double-write a library price.
 *
 * "Transaction-ish": Supabase JS has no multi-statement transaction
 * API available here, so this does the invoice update first (the
 * authoritative "this invoice is approved" fact), then the cost_line/
 * library_items updates. If a later write fails, the invoice is already
 * approved but that write wasn't applied — surfaced as a 207 (partial
 * success) with a `warning` telling the admin what to redo manually
 * (re-running approve on an already-approved invoice is rejected, so a
 * clean retry route doesn't exist yet; flagged as a known follow-up
 * rather than silently swallowed, same as the pre-r24 version of this
 * route already documented for the cost_line-update failure case).
 */
export async function POST(
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
      { error: "Only admins can approve invoices" },
      { status: 403 }
    );
  }

  // Body is optional — every pre-r24 caller sends none. An unparsable
  // (but present) body is a real client error; a genuinely empty body
  // is treated as `{}` (no override of the default toggle behaviour).
  let input: ApproveInvoiceInput = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      input = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const { data: existing, error: fetchError } = await supabase
    .from("invoices")
    .select("*, invoice_allocations(*), supplier_invoice_lines(*)")
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
  const existingWithAllocations = existing as unknown as InvoiceWithAllocations;
  const allocations = existingWithAllocations.invoice_allocations ?? [];

  if (allocations.length === 0 && (!existing.proposed_match_type || !existing.proposed_match_id)) {
    return NextResponse.json(
      { error: "Invoice has no saved allocations to approve" },
      { status: 400 }
    );
  }

  // Migration 060 split path. The RPC locks the invoice, re-validates
  // every target and exact-cent total, applies all cost actuals, and
  // marks the invoice approved in one database transaction. Any error
  // rolls the whole approval back.
  if (allocations.length > 0) {
    const { data: libraryCostApplied, error: splitError } = await supabase.rpc(
      "approve_supplier_invoice_allocations",
      { p_invoice_id: id, p_approved_by: info.userId }
    );
    if (splitError) {
      return NextResponse.json({ error: splitError.message }, { status: 400 });
    }

    const { data: approved, error: reloadError } = await supabase
      .from("invoices")
      .select("*, invoice_allocations(*), supplier_invoice_lines(*)")
      .eq("id", id)
      .single();
    if (reloadError || !approved) {
      return NextResponse.json({ error: reloadError?.message ?? "Invoice not found" }, { status: 500 });
    }

    const typedApproved = approved as unknown as InvoiceWithAllocations;
    typedApproved.invoice_allocations = [...(typedApproved.invoice_allocations ?? [])].sort(
      (a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)
    );
    typedApproved.supplier_invoice_lines = [...(typedApproved.supplier_invoice_lines ?? [])].sort(
      (a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)
    );

    if (typedApproved.source === "aria") {
      await closeBriefItem(
        supabase,
        "invoice",
        `/projects/${typedApproved.project_id}/invoices`,
        `Aria flagged a supplier invoice — ${typedApproved.supplier} #${typedApproved.invoice_number}`
      );
    }

    const payload: ApproveInvoiceResponse = {
      invoice: typedApproved,
      library_cost_applied: libraryCostApplied === true,
    };
    return NextResponse.json(payload);
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

  const typedInvoice = invoice as InvoiceWithIntake;
  const warnings: string[] = [];

  // BUILD-SPEC.md r27 item 10 — Daily Brief self-close. Only meaningful
  // for an Aria-flagged invoice (source='aria'), which is the only kind
  // that raises a daily_brief_items row at all (POST /api/projects/[id]/
  // invoices' own insert, title+link_href reconstructed identically
  // here) — a manually-created invoice never had one to close, and
  // closeBriefItem is a no-op (0 rows matched) in that case anyway.
  // Best-effort, never blocks the approve, which already committed above.
  if (typedInvoice.source === "aria") {
    await closeBriefItem(
      supabase,
      "invoice",
      `/projects/${typedInvoice.project_id}/invoices`,
      `Aria flagged a supplier invoice — ${typedInvoice.supplier} #${typedInvoice.invoice_number}`
    );
  }

  // Resolve the affected item (for the library-cost sync below) while
  // applying the cost_line/item match's own actual_paid_ex_gst credit.
  type AffectedItem = { id: string; quantity: number; library_item_id: string | null };
  type AffectedComponent = {
    id: string;
    item_id: string;
    quantity_per_item: number;
    library_item_id: string | null;
    parent_quantity: number;
  };
  let affectedItem: AffectedItem | null = null;
  let affectedComponent: AffectedComponent | null = null;

  if (typedInvoice.proposed_match_type === "cost_line") {
    const { data: line, error: lineFetchError } = await supabase
      .from("cost_lines")
      .select("id, actual_paid_ex_gst, item_id")
      .eq("id", typedInvoice.proposed_match_id)
      .single();

    if (lineFetchError || !line) {
      warnings.push("its matched cost line could not be found — actuals were not updated");
    } else {
      const nextActual = roundToCents((line.actual_paid_ex_gst ?? 0) + typedInvoice.amount_ex_gst);
      const { error: lineUpdateError } = await supabase
        .from("cost_lines")
        .update({ actual_paid_ex_gst: nextActual })
        .eq("id", line.id);
      if (lineUpdateError) {
        warnings.push(`updating the cost line failed: ${lineUpdateError.message}`);
      }
      if (line.item_id) {
        const { data: item } = await supabase
          .from("items")
          .select("id, quantity, library_item_id")
          .eq("id", line.item_id)
          .maybeSingle();
        if (item) affectedItem = item as AffectedItem;
      }
    }
  } else if (typedInvoice.proposed_match_type === "item") {
    // r24 item 7 — see this route's own header comment for the full
    // "why cost_lines.actual_paid_ex_gst, not a new items column" story.
    const { data: item } = await supabase
      .from("items")
      .select("id, quantity, library_item_id")
      .eq("id", typedInvoice.proposed_match_id)
      .maybeSingle();
    if (item) affectedItem = item as AffectedItem;

    const { data: linkedLines, error: linesFetchError } = await supabase
      .from("cost_lines")
      .select("id, actual_paid_ex_gst")
      .eq("item_id", typedInvoice.proposed_match_id)
      .is("deleted_at", null);

    if (linesFetchError) {
      warnings.push(`could not look up cost lines for this item: ${linesFetchError.message}`);
    } else if (!linkedLines || linkedLines.length === 0) {
      warnings.push("this item has no linked cost line — actuals were not updated (link one in the Estimate first)");
    } else if (linkedLines.length > 1) {
      warnings.push(
        `this item is linked to ${linkedLines.length} cost lines — actuals were not updated automatically (ambiguous which line the payment applies to; apply it manually in the Estimate)`
      );
    } else {
      const line = linkedLines[0];
      const nextActual = roundToCents((line.actual_paid_ex_gst ?? 0) + typedInvoice.amount_ex_gst);
      const { error: lineUpdateError } = await supabase
        .from("cost_lines")
        .update({ actual_paid_ex_gst: nextActual })
        .eq("id", line.id);
      if (lineUpdateError) {
        warnings.push(`updating the cost line failed: ${lineUpdateError.message}`);
      }
    }
  } else if (typedInvoice.proposed_match_type === "item_component") {
    const { data: component } = await supabase
      .from("item_components")
      .select("id,item_id,quantity_per_item,library_item_id,items!inner(quantity)")
      .eq("id", typedInvoice.proposed_match_id)
      .is("deleted_at", null)
      .maybeSingle();
    const parent = component?.items as unknown as { quantity: number } | null;
    if (component && parent) {
      affectedComponent = {
        id: component.id,
        item_id: component.item_id,
        quantity_per_item: Number(component.quantity_per_item),
        library_item_id: component.library_item_id,
        parent_quantity: Number(parent.quantity),
      };
    }

    const { data: linkedLines, error: linesFetchError } = component
      ? await supabase
          .from("cost_lines")
          .select("id, actual_paid_ex_gst")
          .eq("item_id", component.item_id)
          .is("deleted_at", null)
      : { data: null, error: null };
    if (!component) {
      warnings.push("its matched assembly component could not be found — actuals were not updated");
    } else if (linesFetchError) {
      warnings.push(`could not look up the assembly's cost line: ${linesFetchError.message}`);
    } else if (!linkedLines || linkedLines.length === 0) {
      warnings.push("this assembly has no linked cost line — actuals were not updated");
    } else if (linkedLines.length > 1) {
      warnings.push("this assembly has more than one linked cost line — actuals were not updated");
    } else {
      const line = linkedLines[0];
      const nextActual = roundToCents((line.actual_paid_ex_gst ?? 0) + typedInvoice.amount_ex_gst);
      const { error: lineUpdateError } = await supabase
        .from("cost_lines")
        .update({ actual_paid_ex_gst: nextActual })
        .eq("id", line.id);
      if (lineUpdateError) warnings.push(`updating the cost line failed: ${lineUpdateError.message}`);
    }
  }

  // r24 item 7, second half — per-line "update the linked library
  // product's cost record" toggle. Default: ON when the affected item
  // carries a library_item_id, OFF otherwise (nothing to update).
  let libraryCostApplied = false;
  if (affectedComponent) {
    const applyToLibraryCost = input.apply_to_library_cost ?? Boolean(affectedComponent.library_item_id);
    if (applyToLibraryCost) {
      const quantity =
        Math.max(affectedComponent.parent_quantity, 1) *
        Math.max(affectedComponent.quantity_per_item, 1);
      const unitCost = roundToCents(typedInvoice.amount_ex_gst / quantity);
      await supabase
        .from("item_components")
        .update({
          price_trade: unitCost,
          trade_price_received_at: new Date().toISOString().slice(0, 10),
          trade_price_source: `Invoice ${typedInvoice.invoice_number} · ${typedInvoice.supplier}`,
        })
        .eq("id", affectedComponent.id);

      if (affectedComponent.library_item_id) {
        const { error: libraryUpdateError } = await supabase
          .from("library_items")
          .update({
            price_trade: unitCost,
            trade_price_received_at: new Date().toISOString().slice(0, 10),
            trade_price_source: `Invoice ${typedInvoice.invoice_number} · ${typedInvoice.supplier}`,
          })
          .eq("id", affectedComponent.library_item_id);
        if (libraryUpdateError) {
          warnings.push(`updating the component's library cost failed: ${libraryUpdateError.message}`);
        } else {
          libraryCostApplied = true;
        }
      }
    }
  } else if (affectedItem?.library_item_id) {
    const applyToLibraryCost = input.apply_to_library_cost ?? true;
    if (applyToLibraryCost) {
      const qty = affectedItem.quantity > 0 ? affectedItem.quantity : 1;
      const unitCost = roundToCents(typedInvoice.amount_ex_gst / qty);
      const { error: libraryUpdateError } = await supabase
        .from("library_items")
        .update({
          price_trade: unitCost,
          // library_items.trade_price_received_at is a `date` column
          // (004_library_scraper.sql) — same .slice(0, 10) convention
          // PATCH /api/library/[id] already uses when it auto-stamps
          // this column on a price_trade change, not a full timestamp.
          trade_price_received_at: new Date().toISOString().slice(0, 10),
          trade_price_source: `Invoice ${typedInvoice.invoice_number} · ${typedInvoice.supplier}`,
        })
        .eq("id", affectedItem.library_item_id);
      if (libraryUpdateError) {
        warnings.push(`updating the library product's cost failed: ${libraryUpdateError.message}`);
      } else {
        libraryCostApplied = true;
      }
    }
  }

  if (libraryCostApplied) {
    await supabase.from("invoices").update({ library_cost_applied: true }).eq("id", id);
    typedInvoice.library_cost_applied = true;
  }

  const payload: ApproveInvoiceResponse = { invoice: typedInvoice, library_cost_applied: libraryCostApplied };
  if (warnings.length > 0) {
    payload.warning = `Invoice approved, but ${warnings.join("; ")}.`;
    return NextResponse.json(payload, { status: 207 });
  }

  return NextResponse.json(payload);
}

function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
