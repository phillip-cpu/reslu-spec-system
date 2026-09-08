import type { FinanceContributionInput } from "../../types/finance";
import type { SupplierCashInvoice } from "./supplier-actuals";

/** An explicitly linked approved bill replaces ONE recurring occurrence, not the series. */
export function reconcileRecurringInvoiceActuals(input: {
  contributions: FinanceContributionInput[];
  recurringContributions: FinanceContributionInput[];
  invoices: SupplierCashInvoice[];
}): { contributions: FinanceContributionInput[]; recurringContributions: FinanceContributionInput[]; billsNeedingLink: number } {
  let contributions = input.contributions.map((item) => ({ ...item, sourceTrace: { ...item.sourceTrace } }));
  const replacedOccurrences = new Set<string>();
  let billsNeedingLink = 0;
  for (const invoice of input.invoices) {
    if (invoice.status !== "approved" || !invoice.recurring_commitment_id || invoice.project_id) continue;
    const billParts = contributions.filter((item) => item.sourceTrace?.supplier_invoice_id === invoice.id);
    if (!billParts.length) continue; // Currency/unapproved sources remain outside the forecast.
    if (!invoice.recurring_due_date) {
      billsNeedingLink += 1;
      continue;
    }
    const key = `${invoice.recurring_commitment_id}:${invoice.recurring_due_date}`;
    if (replacedOccurrences.has(key)) throw new Error("Two approved bills replace the same recurring occurrence");
    replacedOccurrences.add(key);
    const manualParts = input.recurringContributions.filter((item) =>
      item.sourceTrace?.recurring_commitment_id === invoice.recurring_commitment_id &&
      item.sourceTrace?.due_date === invoice.recurring_due_date && (item.actualPaidMinor ?? 0) > 0
    );
    if (!manualParts.length) continue;

    // A manual settlement and the linked invoice describe the SAME payment,
    // never two payments. Preserve the dated manual ledger and only append any
    // additional invoice-reported cash. Disagreement is exposed for review.
    const manualPaid = manualParts.reduce((sum, item) => sum + (item.actualPaidMinor ?? 0), 0);
    const billPaid = billParts.reduce((sum, item) => sum + (item.actualPaidMinor ?? 0), 0);
    const accrued = billParts.reduce((sum, item) => sum + (item.actualAccruedMinor ?? 0), 0);
    const paid = Math.max(manualPaid, billPaid);
    const template = billParts[0];
    const datedParts = [...billParts].filter((item) => (item.actualPaidMinor ?? 0) > 0)
      .sort((a, b) => String(a.actualPaidDate ?? "9999").localeCompare(String(b.actualPaidDate ?? "9999")));
    const uncoveredBillPaid = datedParts.map((item) => item.actualPaidMinor ?? 0);
    let unmatchedManualPaid = 0;
    // A manually recorded payment may be the LAST instalment, not the first.
    // Match dated evidence before consuming an aggregate's unmatched balance.
    for (const manual of manualParts) {
      let remaining = manual.actualPaidMinor ?? 0;
      datedParts.forEach((part, index) => {
        if (part.actualPaidDate !== manual.actualPaidDate) return;
        const covered = Math.min(remaining, uncoveredBillPaid[index]);
        uncoveredBillPaid[index] -= covered;
        remaining -= covered;
      });
      unmatchedManualPaid += remaining;
    }
    if (unmatchedManualPaid > 0 && billPaid >= manualPaid && (invoice.payment_history?.length ?? 0) > 0) {
      // Complete invoice history disagrees with the manual dates. Keep its
      // actual cash dates intact and ask for reconciliation, not a redating.
      contributions = contributions.map((item) => item.sourceTrace?.supplier_invoice_id === invoice.id
        ? { ...item, sourceTrace: { ...item.sourceTrace, recurring_payment_date_conflict: true } }
        : item);
      continue;
    }
    const trace = { ...template.sourceTrace,
      recurring_payment_conflict: manualPaid > billPaid ? "manual_paid_exceeds_bill" : null,
      recurring_manual_paid_minor: manualPaid,
      recurring_bill_paid_minor: billPaid,
    };
    contributions = contributions.filter((item) => item.sourceTrace?.supplier_invoice_id !== invoice.id);
    contributions.push({ ...template, plannedMinor: 0, committedMinor: 0,
      actualAccruedMinor: Math.max(accrued - paid, 0), actualPaidMinor: 0, actualPaidDate: null,
      sourceTrace: trace });
    manualParts.forEach((item, index) => contributions.push({
      ...template, contributionKey: `${template.contributionKey}:recurring-paid:${index}`,
      plannedMinor: 0, committedMinor: 0,
      actualAccruedMinor: item.actualPaidMinor, actualPaidMinor: item.actualPaidMinor,
      actualPaidDate: item.actualPaidDate, sourceTrace: trace,
    }));
    if (billPaid > manualPaid) {
      // Legacy aggregate dates may not include the earlier manual date.
      // Consume only the amount not already matched by date above.
      let represented = unmatchedManualPaid;
      datedParts.forEach((part, index) => {
        const covered = Math.min(represented, uncoveredBillPaid[index]);
        represented -= covered;
        const additional = uncoveredBillPaid[index] - covered;
        if (!additional) return;
        contributions.push({ ...template, contributionKey: `${template.contributionKey}:bill-paid:${index}`,
          plannedMinor: 0, committedMinor: 0, actualAccruedMinor: additional,
          actualPaidMinor: additional, actualPaidDate: part.actualPaidDate, sourceTrace: trace });
      });
    }
  }
  return {
    contributions,
    recurringContributions: input.recurringContributions.filter((item) => !replacedOccurrences.has(
      `${String(item.sourceTrace?.recurring_commitment_id)}:${String(item.sourceTrace?.due_date)}`
    )),
    billsNeedingLink,
  };
}
