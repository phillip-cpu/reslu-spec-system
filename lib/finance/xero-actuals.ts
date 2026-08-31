import type { ClientInvoice } from "@/types/client-invoices";
import type { FinanceContributionInput } from "@/types/finance";
import type { SupplierCashInvoice } from "./supplier-actuals";

export interface CachedXeroInvoice {
  xero_invoice_id: string;
  invoice_type: "ACCREC" | "ACCPAY";
  status: string;
  invoice_number: string | null;
  contact_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  amount_credited: number | string | null;
}

export interface CachedXeroPayment {
  xero_invoice_id: string | null;
  payment_date: string | null;
  status: string | null;
}

export interface XeroActualContributionResult {
  contributions: FinanceContributionInput[];
  matchedClientInvoices: number;
  matchedSupplierInvoices: number;
  unmatchedInvoices: number;
  includedInvoices: number;
}

const INCLUDED_STATUSES = new Set(["AUTHORISED", "PAID"]);

function normaliseInvoiceNumber(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normaliseName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function apportionMinor(total: number, weights: number[]): number[] {
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (weights.length === 0 || weightTotal <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => total * Math.max(weight, 0) / weightTotal);
  const result = exact.map(Math.floor);
  const remainder = total - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) result[order[index % order.length].index] += 1;
  return result;
}

function dollarsToMinor(value: number | string | null): number {
  const parsed = Number(value ?? 0);
  const minor = Math.round(Math.max(parsed, 0) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error("Xero amount exceeds safe minor units");
  return minor;
}

/**
 * Converts Xero's authorised invoices into cashflow facts. Sales invoices are
 * overlaid onto matching RESLU claims by invoice number; this replaces the
 * internal status rather than adding a second inflow. Unmatched records remain
 * explicit Xero entries so accounting cash facts are not silently discarded.
 */
export function applyXeroInvoiceActuals(input: {
  contributions: FinanceContributionInput[];
  clientInvoices: ClientInvoice[];
  supplierInvoices?: SupplierCashInvoice[];
  xeroInvoices: CachedXeroInvoice[];
  xeroPayments: CachedXeroPayment[];
}): XeroActualContributionResult {
  const result = input.contributions.map((contribution) => ({
    ...contribution,
    sourceTrace: { ...(contribution.sourceTrace ?? {}) },
  }));
  const contributionIndexByClientInvoiceId = new Map<string, number>();
  result.forEach((contribution, index) => {
    const id = contribution.sourceTrace?.client_invoice_id;
    if (typeof id === "string") contributionIndexByClientInvoiceId.set(id, index);
  });
  const clientInvoiceByNumber = new Map(
    input.clientInvoices
      .map((invoice) => [normaliseInvoiceNumber(invoice.invoice_number), invoice] as const)
      .filter(([number]) => number)
  );
  const supplierInvoicesByNumber = new Map<string, SupplierCashInvoice[]>();
  for (const invoice of input.supplierInvoices ?? []) {
    const number = normaliseInvoiceNumber(invoice.invoice_number);
    if (!number) continue;
    supplierInvoicesByNumber.set(number, [...(supplierInvoicesByNumber.get(number) ?? []), invoice]);
  }
  const contributionIndicesBySupplierInvoiceId = new Map<string, number[]>();
  result.forEach((contribution, index) => {
    const id = contribution.sourceTrace?.supplier_invoice_id;
    if (typeof id !== "string") return;
    contributionIndicesBySupplierInvoiceId.set(id, [
      ...(contributionIndicesBySupplierInvoiceId.get(id) ?? []),
      index,
    ]);
  });
  const paidDateByInvoiceId = new Map<string, string>();
  for (const payment of input.xeroPayments) {
    if (!payment.xero_invoice_id || !payment.payment_date || payment.status === "DELETED") continue;
    const existing = paidDateByInvoiceId.get(payment.xero_invoice_id);
    if (!existing || payment.payment_date > existing) {
      paidDateByInvoiceId.set(payment.xero_invoice_id, payment.payment_date);
    }
  }

  let matchedClientInvoices = 0;
  let matchedSupplierInvoices = 0;
  let unmatchedInvoices = 0;
  let includedInvoices = 0;
  for (const invoice of input.xeroInvoices) {
    if (!INCLUDED_STATUSES.has(invoice.status.toUpperCase())) continue;
    const grossMinor = dollarsToMinor(invoice.total);
    const creditedMinor = Math.min(dollarsToMinor(invoice.amount_credited), grossMinor);
    const accruedMinor = grossMinor - creditedMinor;
    if (accruedMinor <= 0) continue;
    const paidMinor = Math.min(dollarsToMinor(invoice.amount_paid), accruedMinor);
    const paidDate = paidDateByInvoiceId.get(invoice.xero_invoice_id) ??
      (invoice.status.toUpperCase() === "PAID" ? invoice.invoice_date : null);
    includedInvoices += 1;

    if (invoice.invoice_type === "ACCREC") {
      const clientInvoice = clientInvoiceByNumber.get(normaliseInvoiceNumber(invoice.invoice_number));
      const contributionIndex = clientInvoice
        ? contributionIndexByClientInvoiceId.get(clientInvoice.id)
        : undefined;
      if (contributionIndex !== undefined) {
        const existing = result[contributionIndex];
        result[contributionIndex] = {
          ...existing,
          actualAccruedMinor: accruedMinor,
          actualPaidMinor: paidMinor,
          actualDueDate: invoice.due_date ?? existing.actualDueDate,
          actualPaidDate: paidMinor > 0 ? paidDate ?? existing.actualPaidDate : null,
          confidence: "confirmed",
          sourceTrace: {
            ...(existing.sourceTrace ?? {}),
            xero_invoice_id: invoice.xero_invoice_id,
            xero_match: "invoice_number",
          },
        };
        matchedClientInvoices += 1;
        continue;
      }
    }

    if (invoice.invoice_type === "ACCPAY") {
      const candidates = supplierInvoicesByNumber.get(normaliseInvoiceNumber(invoice.invoice_number)) ?? [];
      const contact = normaliseName(invoice.contact_name);
      const supplierInvoice = candidates.find(
        (candidate) => contact && normaliseName(candidate.supplier) === contact
      ) ?? (!contact && candidates.length === 1 ? candidates[0] : undefined);
      const indices = supplierInvoice
        ? contributionIndicesBySupplierInvoiceId.get(supplierInvoice.id) ?? []
        : [];
      if (supplierInvoice && indices.length > 0) {
        const weights = indices.map((index) => result[index].actualAccruedMinor ?? 0);
        const accruedShares = apportionMinor(accruedMinor, weights);
        const paidShares = apportionMinor(paidMinor, accruedShares);
        indices.forEach((index, shareIndex) => {
          const existing = result[index];
          result[index] = {
            ...existing,
            actualAccruedMinor: accruedShares[shareIndex],
            actualPaidMinor: paidShares[shareIndex],
            actualDueDate: invoice.due_date ?? existing.actualDueDate,
            actualPaidDate: paidShares[shareIndex] > 0 ? paidDate ?? existing.actualPaidDate : null,
            confidence: "confirmed",
            sourceTrace: {
              ...(existing.sourceTrace ?? {}),
              xero_invoice_id: invoice.xero_invoice_id,
              xero_match: "supplier_invoice_number",
            },
          };
        });
        matchedSupplierInvoices += 1;
        continue;
      }
    }

    unmatchedInvoices += 1;
    result.push({
      contributionKey: `xero:invoice:${invoice.xero_invoice_id}`,
      direction: invoice.invoice_type === "ACCREC" ? "inflow" : "outflow",
      description: `${invoice.invoice_type === "ACCREC" ? "Xero client invoice" : "Xero supplier bill"}${invoice.invoice_number ? ` — ${invoice.invoice_number}` : ""}`,
      plannedMinor: accruedMinor,
      actualAccruedMinor: accruedMinor,
      actualPaidMinor: paidMinor,
      plannedDate: invoice.due_date ?? invoice.invoice_date,
      actualDueDate: invoice.due_date ?? invoice.invoice_date,
      actualPaidDate: paidMinor > 0 ? paidDate : null,
      baseEligible: true,
      confidence: "confirmed",
      sourceTrace: {
        source_type: "xero_invoice",
        source_record_id: invoice.xero_invoice_id,
        xero_invoice_number: invoice.invoice_number,
        supplier_or_payee: invoice.contact_name,
        reconciliation: "unmatched",
      },
    });
  }

  return {
    contributions: result,
    matchedClientInvoices,
    matchedSupplierInvoices,
    unmatchedInvoices,
    includedInvoices,
  };
}
