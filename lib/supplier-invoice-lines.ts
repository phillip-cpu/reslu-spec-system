import type { InvoiceMatchType } from "../types/index.ts";
import { moneyToCents } from "./invoice-allocations.ts";

export const MAX_SUPPLIER_INVOICE_LINES = 100;

export interface SupplierInvoiceLineInput {
  supplier_item_code?: string | null;
  description: string;
  quantity: number;
  unit?: string | null;
  unit_price_ex_gst?: number | null;
  amount_ex_gst: number;
  gst?: number | null;
  amount_inc_gst?: number | null;
  raw_text?: string | null;
  suggested_match_type?: InvoiceMatchType | null;
  suggested_match_id?: string | null;
  suggestion_note?: string | null;
  apply_to_library_cost?: boolean;
}

export interface NormalizedSupplierInvoiceLine extends SupplierInvoiceLineInput {
  supplier_item_code: string | null;
  unit: string | null;
  unit_price_ex_gst: number | null;
  gst: number | null;
  amount_inc_gst: number | null;
  raw_text: string | null;
  suggested_match_type: InvoiceMatchType | null;
  suggested_match_id: string | null;
  suggestion_note: string | null;
  apply_to_library_cost: boolean;
  sort: number;
}

export interface SupplierLineCostLineInput {
  description: string;
  qty: number;
  unit: string | null;
  rate_ex_gst: number | null;
  cost_ex_gst: number;
  notes: string;
}

export type SupplierInvoiceLineValidation =
  | { ok: true; lines: NormalizedSupplierInvoiceLine[]; line_total_cents: number }
  | { ok: false; error: string };

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalMoney(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return moneyToCents(number) / 100;
}

/**
 * Turns immutable supplier evidence into a new project estimate line. The
 * invoice amount becomes the forecast cost, while actual_paid_ex_gst is left
 * untouched until the separate invoice approval step.
 */
export function supplierLineCostLineInput(
  line: Pick<
    SupplierInvoiceLineInput,
    | "description"
    | "quantity"
    | "unit"
    | "unit_price_ex_gst"
    | "amount_ex_gst"
    | "supplier_item_code"
  >
): SupplierLineCostLineInput {
  const supplierCode = optionalText(line.supplier_item_code);
  return {
    description: line.description.trim(),
    qty: line.quantity,
    unit: optionalText(line.unit),
    rate_ex_gst:
      line.unit_price_ex_gst === undefined || line.unit_price_ex_gst === null
        ? null
        : moneyToCents(Number(line.unit_price_ex_gst)) / 100,
    cost_ex_gst: moneyToCents(Number(line.amount_ex_gst)) / 100,
    notes: `Created from supplier invoice line${supplierCode ? ` (SKU ${supplierCode})` : ""}.`,
  };
}

/**
 * Supplier lines are immutable invoice evidence. Their ex-GST total must
 * reconcile exactly to the invoice before the draft can be stored. Project
 * matches remain suggestions until an admin saves the corresponding
 * allocations and explicitly approves the invoice.
 */
export function validateSupplierInvoiceLines(
  raw: unknown,
  invoiceAmountExGst: number,
  options: { allowEmpty?: boolean } = {}
): SupplierInvoiceLineValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "line_items must be an array" };
  }
  if (raw.length === 0) {
    return options.allowEmpty
      ? { ok: true, lines: [], line_total_cents: 0 }
      : { ok: false, error: "Add at least one supplier invoice line" };
  }
  if (raw.length > MAX_SUPPLIER_INVOICE_LINES) {
    return {
      ok: false,
      error: `An invoice can have no more than ${MAX_SUPPLIER_INVOICE_LINES} supplier lines`,
    };
  }

  const invoiceCents = moneyToCents(invoiceAmountExGst);
  if (!Number.isFinite(invoiceAmountExGst) || invoiceCents <= 0) {
    return { ok: false, error: "Invoice amount must be greater than zero" };
  }

  const lines: NormalizedSupplierInvoiceLine[] = [];
  let lineTotalCents = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `Supplier line ${index + 1} is invalid` };
    }
    const record = value as Record<string, unknown>;
    const description = optionalText(record.description);
    const quantity = Number(record.quantity);
    const amount = Number(record.amount_ex_gst);
    const unitPrice = optionalMoney(record.unit_price_ex_gst);
    const gst = optionalMoney(record.gst);
    const amountIncGst = optionalMoney(record.amount_inc_gst);

    if (!description) {
      return { ok: false, error: `Supplier line ${index + 1} needs a description` };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, error: `Supplier line ${index + 1} quantity must be greater than zero` };
    }
    if (!Number.isFinite(amount) || moneyToCents(amount) <= 0) {
      return { ok: false, error: `Supplier line ${index + 1} amount must be greater than zero` };
    }
    if (unitPrice === undefined || (unitPrice !== null && unitPrice < 0)) {
      return { ok: false, error: `Supplier line ${index + 1} has an invalid unit price` };
    }
    if (gst === undefined || (gst !== null && gst < 0)) {
      return { ok: false, error: `Supplier line ${index + 1} has invalid GST` };
    }
    if (amountIncGst === undefined || (amountIncGst !== null && amountIncGst <= 0)) {
      return { ok: false, error: `Supplier line ${index + 1} has an invalid inc-GST amount` };
    }

    const suggestedMatchType = record.suggested_match_type ?? null;
    const suggestedMatchId = optionalText(record.suggested_match_id);
    if (
      suggestedMatchType !== null &&
      suggestedMatchType !== "cost_line" &&
      suggestedMatchType !== "item"
    ) {
      return { ok: false, error: `Supplier line ${index + 1} has an invalid suggested match type` };
    }
    if ((suggestedMatchType && !suggestedMatchId) || (!suggestedMatchType && suggestedMatchId)) {
      return {
        ok: false,
        error: `Supplier line ${index + 1} suggested match type and id must be set together`,
      };
    }

    const amountCents = moneyToCents(amount);
    lineTotalCents += amountCents;
    lines.push({
      supplier_item_code: optionalText(record.supplier_item_code),
      description,
      quantity,
      unit: optionalText(record.unit),
      unit_price_ex_gst: unitPrice,
      amount_ex_gst: amountCents / 100,
      gst,
      amount_inc_gst: amountIncGst,
      raw_text: optionalText(record.raw_text),
      suggested_match_type: suggestedMatchType as InvoiceMatchType | null,
      suggested_match_id: suggestedMatchId,
      suggestion_note: optionalText(record.suggestion_note),
      apply_to_library_cost: record.apply_to_library_cost === true,
      sort: index,
    });
  }

  if (lineTotalCents !== invoiceCents) {
    const difference = Math.abs(invoiceCents - lineTotalCents) / 100;
    const direction = lineTotalCents < invoiceCents ? "under" : "over";
    return {
      ok: false,
      error: `Supplier lines are ${direction} the invoice ex-GST total by $${difference.toFixed(2)}`,
    };
  }

  return { ok: true, lines, line_total_cents: lineTotalCents };
}
