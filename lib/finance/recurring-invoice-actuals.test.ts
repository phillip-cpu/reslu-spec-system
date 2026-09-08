import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRecurringInvoiceActuals } from "./recurring-invoice-actuals.ts";
import { reconcileSupplierInvoiceActuals } from "./supplier-actuals.ts";
import { calculateShadowProjection } from "./projection.ts";
import type { SupplierCashInvoice } from "./supplier-actuals";
import type { FinanceContributionInput } from "../../types/finance";

const bill: SupplierCashInvoice = {
  id: "rent", project_id: null, currency_code: "AUD", supplier: "Landlord", invoice_number: "R1",
  recurring_commitment_id: "r1", recurring_due_date: "2026-09-13", invoice_date: "2026-09-01",
  due_date: "2026-09-13", total: 100, amount_ex_gst: 100, gst: 0, status: "approved",
  payment_status: "paid", amount_paid: 100, paid_at: "2026-09-04",
};
const planned: FinanceContributionInput = {
  contributionKey: "recurring:r1:2026-09-13", description: "Rent", direction: "outflow",
  plannedMinor: 10000, plannedDate: "2026-09-13",
  sourceTrace: { source: "recurring_commitment", recurring_commitment_id: "r1", due_date: "2026-09-13" },
};
function reconcile(invoice = bill, recurring = [planned]) {
  return reconcileRecurringInvoiceActuals({ invoices: [invoice], recurringContributions: recurring,
    contributions: reconcileSupplierInvoiceActuals({ invoices: [invoice], contributions: [] }).contributions });
}
function week(result: ReturnType<typeof reconcile>) {
  return calculateShadowProjection({ asOfDate: "2026-09-08", openingCashAsOfDate: "2026-09-07",
    openingCashMinor: 200000, contributions: [...result.contributions, ...result.recurringContributions] }).periods[0];
}
test("rent paid last week replaces only its linked future occurrence", () => {
  const next = { ...planned, contributionKey: "recurring:r1:2026-09-20", plannedDate: "2026-09-20",
    sourceTrace: { ...planned.sourceTrace, due_date: "2026-09-20" } };
  const result = reconcile(bill, [planned, next]);
  assert.equal(week(result).outflowMinor, 0);
  assert.deepEqual(result.recurringContributions, [next]);
});
test("a partial bill replaces forecast with only its remaining balance", () => {
  assert.equal(week(reconcile({ ...bill, payment_status: "part_paid", amount_paid: 40 })).outflowMinor, 6000);
});
test("missing recurring occurrence is flagged rather than guessed from invoice dates", () => {
  const result = reconcile({ ...bill, recurring_due_date: null });
  assert.equal(result.billsNeedingLink, 1);
  assert.equal(result.recurringContributions.length, 1);
});
test("manual early payment and linked bill are cumulative evidence, not separate payments", () => {
  const manual: FinanceContributionInput = { ...planned, contributionKey: "manual", plannedMinor: 0,
    actualAccruedMinor: 10000, actualPaidMinor: 10000, actualPaidDate: "2026-09-04" };
  const result = reconcile({ ...bill, payment_status: "unpaid", amount_paid: 0, paid_at: null }, [manual]);
  assert.equal(week(result).outflowMinor, 0);
  assert.equal(result.contributions.reduce((sum, item) => sum + (item.actualPaidMinor ?? 0), 0), 10000);
  assert.equal(result.contributions[0].sourceTrace?.recurring_payment_conflict, "manual_paid_exceeds_bill");
});
test("new payment after the snapshot does not move earlier manual payment into this week", () => {
  const manual: FinanceContributionInput = { ...planned, contributionKey: "manual", plannedMinor: 0,
    actualAccruedMinor: 4000, actualPaidMinor: 4000, actualPaidDate: "2026-09-04" };
  assert.equal(week(reconcile({ ...bill, paid_at: "2026-09-08" }, [manual])).outflowMinor, 6000);
});

test("manual latest instalment matches the same date, not an earlier invoice payment", () => {
  const manual: FinanceContributionInput = { ...planned, contributionKey: "manual", plannedMinor: 0,
    actualAccruedMinor: 6000, actualPaidMinor: 6000, actualPaidDate: "2026-09-08" };
  const result = reconcile({ ...bill, paid_at: "2026-09-08", payment_history: [
    { amount_minor: 4000, paid_on: "2026-09-04" }, { amount_minor: 6000, paid_on: "2026-09-08" },
  ] }, [manual]);
  assert.equal(week(result).outflowMinor, 6000);
  assert.equal(result.contributions.reduce((sum, item) => sum + (item.actualPaidMinor ?? 0), 0), 10000);
});

test("conflicting manual dates cannot rewrite a complete invoice payment ledger", () => {
  const manual: FinanceContributionInput = { ...planned, contributionKey: "manual", plannedMinor: 0,
    actualAccruedMinor: 6000, actualPaidMinor: 6000, actualPaidDate: "2026-09-08" };
  const result = reconcile({ ...bill, paid_at: "2026-09-04", payment_history: [
    { amount_minor: 10000, paid_on: "2026-09-04" },
  ] }, [manual]);
  assert.equal(week(result).outflowMinor, 0);
  assert.equal(result.contributions[0].sourceTrace?.recurring_payment_date_conflict, true);
});
