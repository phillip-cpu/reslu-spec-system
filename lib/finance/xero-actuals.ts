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

/** Cache totals are not evidence that a recorded payment has been reversed. */
function mergePaymentAmounts(
  existing: FinanceContributionInput[],
  xeroAccruedMinor: number,
  xeroPaidMinor: number
) {
  const localPaidShares = existing.map((contribution) => contribution.actualPaidMinor ?? 0);
  const localPaidMinor = localPaidShares.reduce((sum, amount) => sum + amount, 0);
  const paidMinor = Math.max(localPaidMinor, xeroPaidMinor);
  // A credit may reduce the invoice balance, but cannot erase cash already paid.
  // Refunds require separate evidence; keep the discrepancy visible for review.
  const accruedMinor = Math.max(xeroAccruedMinor, paidMinor);
  const weights = existing.map((contribution, index) => Math.max(
    (contribution.actualAccruedMinor ?? 0) - localPaidShares[index], 0
  ));
  const remainingAccruedShares = apportionMinor(
    accruedMinor - localPaidMinor,
    weights.some((weight) => weight > 0) ? weights : existing.map(() => 1)
  );
  const accruedShares = localPaidShares.map((paid, index) => paid + remainingAccruedShares[index]);
  const additionalPaidShares = apportionMinor(paidMinor - localPaidMinor, remainingAccruedShares);
  return {
    accruedShares,
    paidShares: localPaidShares.map((paid, index) => paid + additionalPaidShares[index]),
    paidMinor,
    accruedMinor,
    localPaidMinor,
    conflict: localPaidMinor > xeroPaidMinor,
  };
}

function mergedPaidDate(
  existing: FinanceContributionInput,
  paidMinor: number,
  xeroPaidDate: string | null,
  preserveLocalPayment: boolean
): string | null {
  if (paidMinor === 0) return null;
  const localPaidMinor = existing.actualPaidMinor ?? 0;
  if (localPaidMinor > 0 && (preserveLocalPayment || paidMinor === localPaidMinor)) {
    return existing.actualPaidDate ?? null;
  }
  return xeroPaidDate ?? existing.actualPaidDate ?? null;
}

/** Keep a known earlier payment separate from a later increase in Xero's total. */
function splitAdditionalPayment(
  existing: FinanceContributionInput,
  merged: FinanceContributionInput,
  xeroPaidDate: string | null
): [FinanceContributionInput, FinanceContributionInput?] {
  const localPaidMinor = existing.actualPaidMinor ?? 0;
  const additionalPaidMinor = (merged.actualPaidMinor ?? 0) - localPaidMinor;
  if (localPaidMinor <= 0 || additionalPaidMinor <= 0 || (existing.actualPaidDate ?? null) === xeroPaidDate) {
    return [merged];
  }
  return [{
    ...merged,
    plannedMinor: Math.max(merged.plannedMinor - additionalPaidMinor, 0),
    committedMinor: merged.committedMinor === undefined
      ? undefined : Math.max(merged.committedMinor - additionalPaidMinor, 0),
    actualAccruedMinor: (merged.actualAccruedMinor ?? 0) - additionalPaidMinor,
    actualPaidMinor: localPaidMinor,
    actualPaidDate: existing.actualPaidDate ?? null,
  }, {
    ...merged,
    contributionKey: `${existing.contributionKey}|xero_payment_increment:${merged.sourceTrace?.xero_invoice_id}:${merged.sourceTrace?.xero_invoice_paid_minor}`,
    plannedMinor: 0,
    committedMinor: 0,
    actualAccruedMinor: additionalPaidMinor,
    actualPaidMinor: additionalPaidMinor,
    plannedDate: null,
    committedDate: null,
    actualDueDate: null,
    actualPaidDate: xeroPaidDate,
    sourceTrace: {
      ...merged.sourceTrace,
      parent_contribution_key: existing.contributionKey,
      xero_payment_component: "incremental",
    },
  }];
}

/**
 * Converts Xero's authorised invoices into cashflow facts. Sales invoices are
 * overlaid onto matching RESLU claims by invoice number without adding a second
 * inflow. Local payment evidence survives a lower cached payment total until a
 * reversal can be reconciled explicitly. Unmatched records remain explicit
 * Xero entries so accounting cash facts are not silently discarded.
 */
export function applyXeroInvoiceActuals(input: {
  contributions: FinanceContributionInput[];
  clientInvoices: ClientInvoice[];
  supplierInvoices?: SupplierCashInvoice[];
  xeroInvoices: CachedXeroInvoice[];
  xeroPayments: CachedXeroPayment[];
}): XeroActualContributionResult {
  const result: FinanceContributionInput[] = input.contributions.map((contribution) => ({
    ...contribution,
    sourceTrace: { ...(contribution.sourceTrace ?? {}) },
  }));
  const contributionIndicesByClientInvoiceId = new Map<string, number[]>();
  result.forEach((contribution, index) => {
    const id = contribution.sourceTrace?.client_invoice_id;
    if (typeof id !== "string") return;
    contributionIndicesByClientInvoiceId.set(id, [
      ...(contributionIndicesByClientInvoiceId.get(id) ?? []), index,
    ]);
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
    // Fully credited supplier bills must still clear their matched local debt.
    // Client contract credits require their separate claim-value reconciliation.
    if (grossMinor <= 0 || (accruedMinor <= 0 && invoice.invoice_type === "ACCREC")) continue;
    const paidMinor = Math.min(dollarsToMinor(invoice.amount_paid), accruedMinor);
    const paidDate = paidDateByInvoiceId.get(invoice.xero_invoice_id) ?? null;
    includedInvoices += 1;

    if (invoice.invoice_type === "ACCREC") {
      const clientInvoice = clientInvoiceByNumber.get(normaliseInvoiceNumber(invoice.invoice_number));
      const indices = clientInvoice
        ? contributionIndicesByClientInvoiceId.get(clientInvoice.id) ?? []
        : [];
      if (indices.length > 0) {
        const payment = mergePaymentAmounts(indices.map((index) => result[index]), accruedMinor, paidMinor);
        indices.forEach((index, shareIndex) => {
          const existing = result[index];
          const merged: FinanceContributionInput = {
            ...existing,
            actualAccruedMinor: payment.accruedShares[shareIndex],
            actualPaidMinor: payment.paidShares[shareIndex],
            actualDueDate: invoice.due_date ?? existing.actualDueDate,
            actualPaidDate: mergedPaidDate(existing, payment.paidShares[shareIndex], paidDate, payment.conflict),
            confidence: "confirmed",
            sourceTrace: {
              ...(existing.sourceTrace ?? {}),
              xero_invoice_id: invoice.xero_invoice_id,
              xero_match: "invoice_number",
              xero_payment_conflict: payment.conflict ? "local_paid_exceeds_xero" : null,
              local_invoice_paid_minor: payment.localPaidMinor,
              xero_invoice_paid_minor: paidMinor,
              xero_invoice_accrued_minor: accruedMinor,
              xero_invoice_credited_minor: creditedMinor,
            },
          };
          const [retained, incremental] = splitAdditionalPayment(existing, merged, paidDate);
          result[index] = retained;
          if (incremental) result.push(incremental);
        });
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
        const payment = mergePaymentAmounts(indices.map((index) => result[index]), accruedMinor, paidMinor);
        indices.forEach((index, shareIndex) => {
          const existing = result[index];
          const merged: FinanceContributionInput = {
            ...existing,
            plannedMinor: accruedMinor === 0 ? 0 : existing.plannedMinor,
            committedMinor: accruedMinor === 0 ? 0 : existing.committedMinor,
            actualAccruedMinor: payment.accruedShares[shareIndex],
            actualPaidMinor: payment.paidShares[shareIndex],
            actualDueDate: invoice.due_date ?? existing.actualDueDate,
            actualPaidDate: mergedPaidDate(existing, payment.paidShares[shareIndex], paidDate, payment.conflict),
            confidence: "confirmed",
            sourceTrace: {
              ...(existing.sourceTrace ?? {}),
              xero_invoice_id: invoice.xero_invoice_id,
              xero_match: "supplier_invoice_number",
              xero_payment_conflict: payment.conflict ? "local_paid_exceeds_xero" : null,
              local_invoice_paid_minor: payment.localPaidMinor,
              xero_invoice_paid_minor: paidMinor,
              xero_invoice_accrued_minor: accruedMinor,
              xero_invoice_credited_minor: creditedMinor,
              payment_status: payment.paidMinor === payment.accruedMinor
                ? "paid"
                : payment.paidMinor > 0 ? "part_paid" : "unpaid",
            },
          };
          const [retained, incremental] = splitAdditionalPayment(existing, merged, paidDate);
          result[index] = retained;
          if (incremental) result.push(incremental);
        });
        matchedSupplierInvoices += 1;
        continue;
      }
    }

    if (accruedMinor === 0) {
      includedInvoices -= 1;
      continue;
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
