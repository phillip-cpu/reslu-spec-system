import type { InvoiceMatchType } from "@/types";

export const MAX_INVOICE_ALLOCATIONS = 100;

export interface InvoiceAllocationInput {
  source_line_id?: string | null;
  match_type: InvoiceMatchType;
  match_id: string;
  amount_ex_gst: number;
  apply_to_library_cost?: boolean;
}

export interface NormalizedInvoiceAllocation extends InvoiceAllocationInput {
  apply_to_library_cost: boolean;
}

export type InvoiceAllocationValidation =
  | { ok: true; allocations: NormalizedInvoiceAllocation[]; allocated_cents: number }
  | { ok: false; error: string };

export function moneyToCents(value: number): number {
  return Math.round(Number(value.toFixed(8)) * 100);
}

export function invoiceAllocationBalance(
  invoiceAmountExGst: number,
  allocations: Array<Pick<InvoiceAllocationInput, "amount_ex_gst">>
): number {
  const allocated = allocations.reduce(
    (sum, allocation) => sum + moneyToCents(Number(allocation.amount_ex_gst)),
    0
  );
  return (moneyToCents(invoiceAmountExGst) - allocated) / 100;
}

/**
 * Validates invoice splits in integer cents. The database repeats these
 * checks transactionally; this helper keeps API/UI errors immediate and
 * gives the rules a fast offline test surface.
 */
export function validateInvoiceAllocations(
  raw: unknown,
  invoiceAmountExGst: number,
  options: { allowEmpty?: boolean } = {}
): InvoiceAllocationValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "allocations must be an array" };
  }
  if (raw.length === 0) {
    return options.allowEmpty
      ? { ok: true, allocations: [], allocated_cents: 0 }
      : { ok: false, error: "Add at least one allocation" };
  }
  if (raw.length > MAX_INVOICE_ALLOCATIONS) {
    return {
      ok: false,
      error: `An invoice can have no more than ${MAX_INVOICE_ALLOCATIONS} allocations`,
    };
  }

  const invoiceCents = moneyToCents(invoiceAmountExGst);
  if (!Number.isFinite(invoiceAmountExGst) || invoiceCents <= 0) {
    return { ok: false, error: "Invoice amount must be greater than zero" };
  }

  const allocations: NormalizedInvoiceAllocation[] = [];
  const seen = new Set<string>();
  let allocatedCents = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `Allocation ${index + 1} is invalid` };
    }
    const record = value as Record<string, unknown>;
    const matchType = record.match_type;
    const matchId = typeof record.match_id === "string" ? record.match_id.trim() : "";
    const amount = Number(record.amount_ex_gst);
    const sourceLineId =
      typeof record.source_line_id === "string" && record.source_line_id.trim()
        ? record.source_line_id.trim()
        : null;

    if (matchType !== "cost_line" && matchType !== "item") {
      return { ok: false, error: `Allocation ${index + 1} has an invalid match type` };
    }
    if (!matchId) {
      return { ok: false, error: `Allocation ${index + 1} needs a match` };
    }
    if (!Number.isFinite(amount) || moneyToCents(amount) <= 0) {
      return { ok: false, error: `Allocation ${index + 1} amount must be greater than zero` };
    }

    // Distinct supplier lines may legitimately post to the same project
    // target (for example tape + protective film -> site consumables).
    // A freehand allocation still cannot repeat a target, while a
    // source-backed allocation is unique by its immutable invoice line.
    const key = sourceLineId ? `source:${sourceLineId}` : `target:${matchType}:${matchId}`;
    if (seen.has(key)) {
      return {
        ok: false,
        error: sourceLineId
          ? `Allocation ${index + 1} repeats the same supplier line`
          : `Allocation ${index + 1} repeats the same match`,
      };
    }
    seen.add(key);

    const amountCents = moneyToCents(amount);
    allocatedCents += amountCents;
    allocations.push({
      source_line_id: sourceLineId,
      match_type: matchType,
      match_id: matchId,
      amount_ex_gst: amountCents / 100,
      apply_to_library_cost: record.apply_to_library_cost === true,
    });
  }

  if (allocatedCents !== invoiceCents) {
    const difference = Math.abs(invoiceCents - allocatedCents) / 100;
    const direction = allocatedCents < invoiceCents ? "under" : "over";
    return {
      ok: false,
      error: `Allocations are ${direction} the invoice total by $${difference.toFixed(2)}`,
    };
  }

  return { ok: true, allocations, allocated_cents: allocatedCents };
}
