import type { FinanceContributionInput } from "@/types/finance";
import type { InvoiceMatchType, SupplierInvoicePaymentStatus } from "@/types";

export interface SupplierCashAllocation {
  id: string;
  match_type: InvoiceMatchType;
  match_id: string;
  amount_ex_gst: number | string;
}

export interface SupplierCashInvoice {
  id: string;
  project_id: string;
  supplier: string;
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  amount_ex_gst: number | string;
  gst: number | string;
  total: number | string;
  status: string;
  payment_status: SupplierInvoicePaymentStatus;
  amount_paid: number | string;
  paid_at: string | null;
  proposed_match_type?: InvoiceMatchType | null;
  proposed_match_id?: string | null;
  invoice_allocations?: SupplierCashAllocation[];
}

export interface SupplierActualReconciliationResult {
  contributions: FinanceContributionInput[];
  includedInvoices: number;
  matchedAllocations: number;
  unmatchedAllocations: number;
  accruedMinor: number;
  paidMinor: number;
}

function dollarsToMinor(value: number | string): number {
  const parsed = Number(value);
  const minor = Math.round(Math.max(Number.isFinite(parsed) ? parsed : 0, 0) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error("Supplier invoice amount exceeds safe minor units");
  return minor;
}

/** Proportional allocation that preserves every cent and is deterministic. */
function apportionMinor(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (weightTotal <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => total * Math.max(weight, 0) / weightTotal);
  const allocated = exact.map(Math.floor);
  const remainder = total - allocated.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remainder; i += 1) allocated[order[i % order.length].index] += 1;
  return allocated;
}

function planKeys(
  projectId: string,
  allocation: SupplierCashAllocation,
  itemCategories: Record<string, string>,
  componentParentItemIds: Record<string, string>
): string[] {
  if (allocation.match_type === "cost_line") {
    return [`project:${projectId}|cost_line:${allocation.match_id}|scope:base`];
  }
  const itemId = allocation.match_type === "item"
    ? allocation.match_id
    : allocation.match_type === "item_component"
      ? componentParentItemIds[allocation.match_id] ?? null
      : null;
  if (!itemId) return [];
  const keys = [`project:${projectId}|ffe_item:${itemId}|scope:base`];
  const category = itemCategories[itemId];
  if (category) keys.push(`project:${projectId}|ffe_category:${category}|scope:base`);
  return keys;
}

/**
 * Replaces the invoiced slice of an estimate with invoice actuals. Keeping the
 * actual allocation on its own key preserves each bill's due/payment date while
 * the linked estimate retains only its uninvoiced balance.
 */
export function reconcileSupplierInvoiceActuals(input: {
  contributions: FinanceContributionInput[];
  invoices: SupplierCashInvoice[];
  itemCategories?: Record<string, string>;
  componentParentItemIds?: Record<string, string>;
}): SupplierActualReconciliationResult {
  const contributions = input.contributions.map((item) => ({
    ...item,
    sourceTrace: { ...(item.sourceTrace ?? {}) },
  }));
  const planIndex = new Map(contributions.map((item, index) => [item.contributionKey, index]));
  const accruedByPlan = new Map<string, number>();
  let includedInvoices = 0;
  let matchedAllocations = 0;
  let unmatchedAllocations = 0;
  let accruedMinor = 0;
  let paidMinor = 0;

  for (const invoice of input.invoices) {
    if (invoice.status !== "approved") continue;
    const saved = invoice.invoice_allocations ?? [];
    const allocations = saved.length > 0
      ? saved
      : invoice.proposed_match_type && invoice.proposed_match_id
        ? [{
            id: `legacy:${invoice.id}`,
            match_type: invoice.proposed_match_type,
            match_id: invoice.proposed_match_id,
            amount_ex_gst: invoice.amount_ex_gst,
          }]
        : [];
    if (allocations.length === 0) continue;

    const weights = allocations.map((allocation) => dollarsToMinor(allocation.amount_ex_gst));
    const invoiceGrossMinor = dollarsToMinor(invoice.total);
    const invoicePaidMinor = Math.min(dollarsToMinor(invoice.amount_paid), invoiceGrossMinor);
    const grossShares = apportionMinor(invoiceGrossMinor, weights);
    const paidShares = apportionMinor(invoicePaidMinor, grossShares);
    includedInvoices += 1;
    accruedMinor += invoiceGrossMinor;
    paidMinor += invoicePaidMinor;

    allocations.forEach((allocation, index) => {
      const matchedPlanKey = planKeys(
        invoice.project_id,
        allocation,
        input.itemCategories ?? {},
        input.componentParentItemIds ?? {}
      ).find((key) => planIndex.has(key)) ?? null;
      const matched = matchedPlanKey !== null;
      const matchedPlanIndex = matchedPlanKey ? planIndex.get(matchedPlanKey) : undefined;
      const matchedPlan = matchedPlanIndex === undefined
        ? null
        : contributions[matchedPlanIndex];
      if (matched && matchedPlanKey) {
        accruedByPlan.set(matchedPlanKey, (accruedByPlan.get(matchedPlanKey) ?? 0) + grossShares[index]);
        matchedAllocations += 1;
      } else {
        unmatchedAllocations += 1;
      }
      contributions.push({
        contributionKey: `supplier:invoice:${invoice.id}|allocation:${allocation.id}`,
        direction: "outflow",
        description: `${invoice.supplier} — ${invoice.invoice_number}`,
        plannedMinor: 0,
        actualAccruedMinor: grossShares[index],
        actualPaidMinor: paidShares[index],
        actualDueDate: invoice.due_date ?? invoice.invoice_date,
        actualPaidDate: paidShares[index] > 0 ? invoice.paid_at : null,
        baseEligible: true,
        confidence: invoice.due_date ? "confirmed" : invoice.invoice_date ? "medium" : "unknown",
        sourceTrace: {
          source_type: "supplier_invoice_allocation",
          source_record_id: allocation.id,
          supplier_invoice_id: invoice.id,
          supplier_invoice_number: invoice.invoice_number,
          supplier: invoice.supplier,
          project_id: invoice.project_id,
          match_type: allocation.match_type,
          match_id: allocation.match_id,
          matched_plan_key: matchedPlanKey,
          category: matchedPlan?.sourceTrace?.category ??
            (allocation.match_type === "item"
              ? input.itemCategories?.[allocation.match_id] ?? null
              : allocation.match_type === "item_component"
                ? input.itemCategories?.[input.componentParentItemIds?.[allocation.match_id] ?? ""] ?? null
                : null),
          parent_item_id: allocation.match_type === "item_component"
            ? input.componentParentItemIds?.[allocation.match_id] ?? null
            : null,
          section_id: matchedPlan?.sourceTrace?.section_id ?? null,
          section_name: matchedPlan?.sourceTrace?.section_name ?? null,
          reconciliation: matched ? "estimate_replaced" : "unmatched_actual",
          payment_status: invoice.payment_status,
          cash_basis: "gross_inc_gst",
        },
      });
    });
  }

  for (const [key, actual] of accruedByPlan) {
    const index = planIndex.get(key);
    if (index === undefined) continue;
    const item = contributions[index];
    const committed = item.committedMinor ?? 0;
    contributions[index] = {
      ...item,
      plannedMinor: committed > 0 ? item.plannedMinor : Math.max(item.plannedMinor - actual, 0),
      committedMinor: committed > 0 ? Math.max(committed - actual, 0) : item.committedMinor,
      sourceTrace: {
        ...(item.sourceTrace ?? {}),
        supplier_actual_replaced_minor: actual,
      },
    };
  }

  return {
    contributions,
    includedInvoices,
    matchedAllocations,
    unmatchedAllocations,
    accruedMinor,
    paidMinor,
  };
}
