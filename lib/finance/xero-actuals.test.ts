import assert from "node:assert/strict";
import test from "node:test";
import { applyXeroInvoiceActuals } from "./xero-actuals.ts";
import { calculateShadowProjection } from "./projection.ts";
import type { FinanceContributionInput } from "../../types/finance";
import type { SupplierCashInvoice } from "./supplier-actuals";
import type { CachedXeroInvoice, CachedXeroPayment } from "./xero-actuals";

function matchingSupplierBill(input: {
  contributions: FinanceContributionInput[];
  xero?: Partial<CachedXeroInvoice>;
  supplier?: Partial<SupplierCashInvoice>;
  payments?: CachedXeroPayment[];
}) {
  return applyXeroInvoiceActuals({
    contributions: input.contributions,
    clientInvoices: [],
    supplierInvoices: [{
      id: "internal-bill", project_id: "p1", supplier: "Trade Co", invoice_number: "SUP-7",
      invoice_date: "2026-08-01", due_date: "2026-08-20", amount_ex_gst: 100, gst: 10,
      total: 110, status: "approved", payment_status: "paid", amount_paid: 110,
      paid_at: "2026-08-18", invoice_allocations: [], ...input.supplier,
    }],
    xeroInvoices: [{
      xero_invoice_id: "bill-1", invoice_type: "ACCPAY", status: "AUTHORISED",
      invoice_number: "SUP 7", contact_name: "Trade Co", invoice_date: "2026-08-01",
      due_date: "2026-08-20", total: 110, amount_paid: 0, amount_credited: 0, ...input.xero,
    }],
    xeroPayments: input.payments ?? [{ xero_invoice_id: "bill-1", payment_date: "2026-09-07", status: "AUTHORISED" }],
  });
}

function supplierAllocation(key: string, accrued: number, paid: number): FinanceContributionInput {
  return {
    contributionKey: key, direction: "outflow", description: "Supplier bill", plannedMinor: 0,
    actualAccruedMinor: accrued, actualPaidMinor: paid,
    actualDueDate: "2026-08-20", actualPaidDate: paid > 0 ? "2026-08-18" : null,
    sourceTrace: { supplier_invoice_id: "internal-bill" },
  };
}

test("Xero sales invoice replaces matching RESLU claim actuals", () => {
  const result = applyXeroInvoiceActuals({
    contributions: [{
      contributionKey: "claim:1",
      direction: "inflow",
      description: "Client claim",
      plannedMinor: 150_000,
      sourceTrace: { client_invoice_id: "internal-1" },
    }],
    clientInvoices: [{ id: "internal-1", invoice_number: "INV-0042" } as never],
    xeroInvoices: [{
      xero_invoice_id: "xero-1",
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      invoice_number: "INV 0042",
      contact_name: "Client",
      invoice_date: "2026-08-01",
      due_date: "2026-08-15",
      total: 1500,
      amount_paid: 500,
      amount_credited: 0,
    }],
    xeroPayments: [{ xero_invoice_id: "xero-1", payment_date: "2026-08-10", status: "AUTHORISED" }],
  });

  assert.equal(result.contributions.length, 1);
  assert.equal(result.contributions[0].actualAccruedMinor, 150_000);
  assert.equal(result.contributions[0].actualPaidMinor, 50_000);
  assert.equal(result.matchedClientInvoices, 1);
  assert.equal(result.matchedSupplierInvoices, 0);
  assert.equal(result.unmatchedInvoices, 0);
});

test("unmatched authorised Xero supplier bill is an explicit outflow", () => {
  const result = applyXeroInvoiceActuals({
    contributions: [],
    clientInvoices: [],
    xeroInvoices: [{
      xero_invoice_id: "bill-1",
      invoice_type: "ACCPAY",
      status: "AUTHORISED",
      invoice_number: "SUP-7",
      contact_name: "Supplier",
      invoice_date: "2026-08-01",
      due_date: "2026-08-20",
      total: 110,
      amount_paid: 0,
      amount_credited: 0,
    }],
    xeroPayments: [],
  });

  assert.equal(result.contributions[0].direction, "outflow");
  assert.equal(result.contributions[0].actualAccruedMinor, 11_000);
  assert.equal(result.unmatchedInvoices, 1);
});

test("matching Xero supplier bill overlays RESLU allocations instead of duplicating them", () => {
  const result = applyXeroInvoiceActuals({
    contributions: [{
      contributionKey: "supplier:invoice:internal-bill|allocation:a1",
      direction: "outflow",
      description: "Supplier bill",
      plannedMinor: 0,
      actualAccruedMinor: 11_000,
      actualPaidMinor: 0,
      sourceTrace: { supplier_invoice_id: "internal-bill" },
    }],
    clientInvoices: [],
    supplierInvoices: [{
      id: "internal-bill",
      project_id: "p1",
      supplier: "Trade Co",
      invoice_number: "SUP-7",
      invoice_date: "2026-08-01",
      due_date: "2026-08-20",
      amount_ex_gst: 100,
      gst: 10,
      total: 110,
      status: "approved",
      payment_status: "unpaid",
      amount_paid: 0,
      paid_at: null,
      invoice_allocations: [],
    }],
    xeroInvoices: [{
      xero_invoice_id: "bill-1",
      invoice_type: "ACCPAY",
      status: "PAID",
      invoice_number: "SUP 7",
      contact_name: "Trade Co",
      invoice_date: "2026-08-01",
      due_date: "2026-08-20",
      total: 110,
      amount_paid: 110,
      amount_credited: 0,
    }],
    xeroPayments: [{ xero_invoice_id: "bill-1", payment_date: "2026-08-18", status: "AUTHORISED" }],
  });
  assert.equal(result.contributions.length, 1);
  assert.equal(result.contributions[0].actualPaidMinor, 11_000);
  assert.equal(result.matchedSupplierInvoices, 1);
  assert.equal(result.unmatchedInvoices, 0);
});

test("stale unpaid Xero bill cannot reopen a locally paid supplier invoice", () => {
  const input = [supplierAllocation("allocation:1", 8_000, 8_000), supplierAllocation("allocation:2", 3_000, 3_000)];
  const before = structuredClone(input);
  const result = matchingSupplierBill({ contributions: input });

  assert.equal(result.contributions.length, 2);
  assert.equal(result.matchedSupplierInvoices, 1);
  assert.deepEqual(result.contributions.map((item) => item.actualPaidMinor), [8_000, 3_000]);
  assert.deepEqual(result.contributions.map((item) => item.actualPaidDate), ["2026-08-18", "2026-08-18"]);
  assert.equal(result.contributions.reduce((sum, item) => sum + item.actualAccruedMinor! - item.actualPaidMinor!, 0), 0);
  for (const item of result.contributions) {
    assert.equal(item.sourceTrace?.xero_payment_conflict, "local_paid_exceeds_xero");
    assert.equal(item.sourceTrace?.local_invoice_paid_minor, 11_000);
    assert.equal(item.sourceTrace?.xero_invoice_paid_minor, 0);
    assert.equal(item.sourceTrace?.payment_status, "paid");
  }
  assert.deepEqual(input, before, "cache reconciliation must not mutate local payment evidence");
});

test("stale partial Xero payment preserves local partial payment and only leaves the unpaid balance", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 7_000, 3_000), supplierAllocation("allocation:2", 4_000, 1_000)],
    supplier: { payment_status: "part_paid", amount_paid: 40 },
    xero: { amount_paid: 20 },
  });

  assert.deepEqual(result.contributions.map((item) => item.actualPaidMinor), [3_000, 1_000]);
  assert.deepEqual(result.contributions.map((item) => item.actualPaidDate), ["2026-08-18", "2026-08-18"]);
  assert.equal(result.contributions.reduce((sum, item) => sum + item.actualAccruedMinor! - item.actualPaidMinor!, 0), 7_000);
  assert.ok(result.contributions.every((item) => item.sourceTrace?.payment_status === "part_paid"));
});

test("new Xero partial payment keeps old cash before opening balance and dates only the increment later", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 7_000, 3_000), supplierAllocation("allocation:2", 4_000, 1_000)],
    supplier: { payment_status: "part_paid", amount_paid: 40 },
    xero: { amount_paid: 55 },
  });

  assert.equal(result.contributions.reduce((sum, item) => sum + item.actualPaidMinor!, 0), 5_500);
  assert.equal(result.contributions.reduce((sum, item) => sum + item.actualAccruedMinor! - item.actualPaidMinor!, 0), 5_500);
  assert.equal(result.contributions[0].actualPaidMinor, 3_000);
  assert.equal(result.contributions[1].actualPaidMinor, 1_000);
  assert.deepEqual(result.contributions.slice(0, 2).map((item) => item.actualPaidDate), ["2026-08-18", "2026-08-18"]);
  assert.equal(result.contributions.filter((item) => item.actualPaidDate === "2026-09-07")
    .reduce((sum, item) => sum + item.actualPaidMinor!, 0), 1_500);
  assert.ok(result.contributions.every((item) => item.sourceTrace?.xero_payment_conflict === null));
  const projection = calculateShadowProjection({
    asOfDate: "2026-09-07", openingCashAsOfDate: "2026-09-06", openingCashMinor: 100_000,
    contributions: result.contributions,
  });
  assert.equal(projection.periods[0].actualOutflowMinor, 1_500);
  assert.equal(projection.periods[0].outflowMinor, 7_000);

  const reapplied = matchingSupplierBill({ contributions: result.contributions, xero: { amount_paid: 55 } });
  assert.deepEqual(reapplied.contributions.map((item) => [item.contributionKey, item.actualPaidMinor, item.actualPaidDate]),
    result.contributions.map((item) => [item.contributionKey, item.actualPaidMinor, item.actualPaidDate]));
});

test("Xero credits reduce unpaid balance without erasing payment evidence or producing negative allocations", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 7_000, 7_000), supplierAllocation("allocation:2", 4_000, 1_000)],
    supplier: { payment_status: "part_paid", amount_paid: 80 },
    xero: { amount_paid: 0, amount_credited: 50 },
  });

  assert.deepEqual(result.contributions.map((item) => item.actualPaidMinor), [7_000, 1_000]);
  assert.deepEqual(result.contributions.map((item) => item.actualAccruedMinor), [7_000, 1_000]);
  assert.ok(result.contributions.every((item) => item.actualPaidDate === "2026-08-18"));
  assert.equal(result.contributions[0].sourceTrace?.xero_invoice_accrued_minor, 6_000);
  assert.equal(result.contributions[0].sourceTrace?.xero_invoice_credited_minor, 5_000);
  assert.equal(result.contributions[0].sourceTrace?.xero_payment_conflict, "local_paid_exceeds_xero");
});

test("supplier names must match exactly after formatting normalization", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 11_000, 11_000)],
    xero: { contact_name: "Trade Co Other Business" },
  });
  assert.equal(result.matchedSupplierInvoices, 0);
  assert.equal(result.unmatchedInvoices, 1);
  assert.equal(result.contributions[0].actualPaidMinor, 11_000);
  assert.equal(result.contributions[1].sourceTrace?.reconciliation, "unmatched");
});

test("stale Xero sales status cannot turn a recorded client receipt back into future income", () => {
  const result = applyXeroInvoiceActuals({
    contributions: [{
      contributionKey: "claim:paid", direction: "inflow", description: "Paid claim", plannedMinor: 15_000,
      actualAccruedMinor: 15_000, actualPaidMinor: 15_000, actualPaidDate: "2026-08-18",
      sourceTrace: { client_invoice_id: "client-1" },
    }],
    clientInvoices: [{ id: "client-1", invoice_number: "INV-7" } as never],
    xeroInvoices: [{
      xero_invoice_id: "xero-client", invoice_type: "ACCREC", status: "AUTHORISED", invoice_number: "INV-7",
      contact_name: "Client", invoice_date: "2026-08-01", due_date: "2026-08-20", total: 150,
      amount_paid: 0, amount_credited: 0,
    }],
    xeroPayments: [],
  });
  assert.equal(result.contributions[0].actualPaidMinor, 15_000);
  assert.equal(result.contributions[0].actualPaidDate, "2026-08-18");
  assert.equal(result.contributions[0].sourceTrace?.xero_payment_conflict, "local_paid_exceeds_xero");
});

test("paid Xero bill without a payment date stays undated rather than using its invoice date", () => {
  for (const matched of [true, false]) {
    const result = matchingSupplierBill({
      contributions: matched ? [supplierAllocation("allocation:1", 11_000, 0)] : [],
      xero: { status: "PAID", amount_paid: 110 }, payments: [],
    });
    assert.equal(result.contributions[0].actualPaidMinor, 11_000);
    assert.equal(result.contributions[0].actualPaidDate, null);
  }
  const preserved = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 11_000, 11_000)],
    xero: { status: "PAID", amount_paid: 110 }, payments: [],
  });
  assert.equal(preserved.contributions[0].actualPaidDate, "2026-08-18");
});

test("undated incremental Xero payment does not borrow the earlier local payment date", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 11_000, 4_000)],
    xero: { amount_paid: 55 }, payments: [],
  });
  assert.equal(result.contributions[0].actualPaidMinor, 4_000);
  assert.equal(result.contributions[0].actualPaidDate, "2026-08-18");
  assert.equal(result.contributions[1].actualPaidMinor, 1_500);
  assert.equal(result.contributions[1].actualPaidDate, null);
});

test("fully credited matched supplier bill clears local unpaid debt without a zero unmatched outflow", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 11_000, 0)],
    xero: { amount_credited: 110 },
  });
  assert.equal(result.matchedSupplierInvoices, 1);
  assert.equal(result.unmatchedInvoices, 0);
  assert.equal(result.contributions[0].actualAccruedMinor, 0);
  assert.equal(result.contributions[0].actualPaidMinor, 0);
  assert.equal(result.contributions[0].plannedMinor, 0);
  const unmatched = matchingSupplierBill({ contributions: [], xero: { amount_credited: 110 } });
  assert.deepEqual(unmatched.contributions, []);
  assert.equal(unmatched.unmatchedInvoices, 0);
  assert.equal(unmatched.includedInvoices, 0);
});

test("fully credited supplier bill preserves a recorded earlier cash payment for reconciliation", () => {
  const result = matchingSupplierBill({
    contributions: [supplierAllocation("allocation:1", 11_000, 4_000)],
    xero: { amount_credited: 110 },
  });
  assert.equal(result.contributions[0].actualAccruedMinor, 4_000);
  assert.equal(result.contributions[0].actualPaidMinor, 4_000);
  assert.equal(result.contributions[0].actualPaidDate, "2026-08-18");
  assert.equal(result.contributions[0].sourceTrace?.xero_payment_conflict, "local_paid_exceeds_xero");
  assert.equal(result.contributions[0].sourceTrace?.xero_invoice_accrued_minor, 0);
});

test("split client receipt preserves the contract total and does not recreate planned income", () => {
  const input = {
    contributions: [{
      contributionKey: "claim:partial", direction: "inflow" as const, description: "Client claim", plannedMinor: 15_000,
      actualAccruedMinor: 15_000, actualPaidMinor: 4_000, actualPaidDate: "2026-08-18",
      actualDueDate: "2026-09-10", sourceTrace: { client_invoice_id: "client-1" },
    }],
    clientInvoices: [{ id: "client-1", invoice_number: "INV-7" } as never],
    xeroInvoices: [{
      xero_invoice_id: "xero-client", invoice_type: "ACCREC" as const, status: "AUTHORISED", invoice_number: "INV-7",
      contact_name: "Client", invoice_date: "2026-08-01", due_date: "2026-09-10", total: 150,
      amount_paid: 55, amount_credited: 0,
    }],
    xeroPayments: [{ xero_invoice_id: "xero-client", payment_date: "2026-09-07", status: "AUTHORISED" }],
  };
  const result = applyXeroInvoiceActuals(input);
  assert.equal(result.contributions.length, 2);
  assert.equal(result.contributions[0].actualPaidDate, "2026-08-18");
  assert.equal(result.contributions[1].actualPaidDate, "2026-09-07");
  const projection = calculateShadowProjection({
    asOfDate: "2026-09-07", openingCashAsOfDate: "2026-09-06", openingCashMinor: 100_000,
    contributions: result.contributions,
  });
  assert.equal(projection.periods[0].actualInflowMinor, 1_500);
  assert.equal(projection.periods[0].inflowMinor, 11_000);
  assert.equal(projection.unknownTimingMinor, 0);
  const reapplied = applyXeroInvoiceActuals({ ...input, contributions: result.contributions });
  assert.equal(reapplied.matchedClientInvoices, 1);
  assert.deepEqual(reapplied.contributions.map((item) => [item.contributionKey, item.actualPaidMinor, item.actualPaidDate]),
    result.contributions.map((item) => [item.contributionKey, item.actualPaidMinor, item.actualPaidDate]));
});
