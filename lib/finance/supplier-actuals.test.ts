import assert from "node:assert/strict";
import test from "node:test";
import { calculateShadowProjection, resolveEffectiveContributions } from "./projection.ts";
import { reconcileSupplierInvoiceActuals } from "./supplier-actuals.ts";

test("supplier actual replaces the invoiced plan slice instead of doubling it", () => {
  const result = reconcileSupplierInvoiceActuals({
    contributions: [{
      contributionKey: "project:p1|cost_line:c1|scope:base",
      direction: "outflow",
      description: "Plumbing",
      plannedMinor: 100_000,
      plannedDate: "2026-09-30",
    }],
    invoices: [{
      id: "i1",
      project_id: "p1",
      supplier: "Trade Co",
      invoice_number: "INV-1",
      invoice_date: "2026-08-01",
      due_date: "2026-08-31",
      amount_ex_gst: 272.73,
      gst: 27.27,
      total: 300,
      status: "approved",
      payment_status: "unpaid",
      amount_paid: 0,
      paid_at: null,
      invoice_allocations: [{ id: "a1", match_type: "cost_line", match_id: "c1", amount_ex_gst: 272.73 }],
    }],
  });

  const resolved = resolveEffectiveContributions(result.contributions).contributions;
  assert.equal(resolved.reduce((sum, item) => sum + item.amountMinor, 0), 100_000);
  assert.equal(resolved.find((item) => item.state === "actual_accrued")?.amountMinor, 30_000);
  assert.equal(resolved.find((item) => item.state === "planned")?.amountMinor, 70_000);
});

test("gross and paid cents are preserved across split allocations", () => {
  const result = reconcileSupplierInvoiceActuals({
    contributions: [],
    invoices: [{
      id: "i2",
      project_id: "p1",
      supplier: "Supplier",
      invoice_number: "SPLIT-1",
      invoice_date: "2026-08-01",
      due_date: "2026-08-20",
      amount_ex_gst: 100,
      gst: 10,
      total: 110,
      status: "approved",
      payment_status: "part_paid",
      amount_paid: 33.33,
      paid_at: "2026-08-10",
      invoice_allocations: [
        { id: "a1", match_type: "item", match_id: "x", amount_ex_gst: 33.33 },
        { id: "a2", match_type: "item", match_id: "y", amount_ex_gst: 66.67 },
      ],
    }],
  });
  assert.equal(result.contributions.reduce((sum, item) => sum + (item.actualAccruedMinor ?? 0), 0), 11_000);
  assert.equal(result.contributions.reduce((sum, item) => sum + (item.actualPaidMinor ?? 0), 0), 3_333);
});

test("item allocations replace their FF&E category plan", () => {
  const result = reconcileSupplierInvoiceActuals({
    contributions: [{
      contributionKey: "project:p1|ffe_category:Tapware|scope:base",
      direction: "outflow",
      description: "FF&E - Tapware",
      plannedMinor: 55_000,
    }],
    itemCategories: { item1: "Tapware" },
    invoices: [{
      id: "i3", project_id: "p1", supplier: "Supplier", invoice_number: "F1",
      invoice_date: "2026-08-01", due_date: "2026-08-10", amount_ex_gst: 100,
      gst: 10, total: 110, status: "approved", payment_status: "unpaid",
      amount_paid: 0, paid_at: null,
      invoice_allocations: [{ id: "a3", match_type: "item", match_id: "item1", amount_ex_gst: 100 }],
    }],
  });
  assert.equal(result.contributions[0].plannedMinor, 44_000);
  assert.equal(result.matchedAllocations, 1);
});

test("historical paid supplier cash is not forecast again in the current week", () => {
  const result = reconcileSupplierInvoiceActuals({
    contributions: [{
      contributionKey: "project:p1|cost_line:ram-board|scope:base",
      direction: "outflow",
      description: "Ram Board Flooring",
      plannedMinor: 28_600,
      plannedDate: "2026-07-08",
    }],
    invoices: [{
      id: "bunnings-1",
      project_id: "p1",
      supplier: "Bunnings",
      invoice_number: "INV-RAM",
      invoice_date: "2026-07-08",
      due_date: null,
      amount_ex_gst: 231.75,
      gst: 23.18,
      total: 254.93,
      status: "approved",
      payment_status: "paid",
      amount_paid: 254.93,
      paid_at: "2026-07-16",
      invoice_allocations: [{
        id: "ram-allocation",
        match_type: "cost_line",
        match_id: "ram-board",
        amount_ex_gst: 231.75,
      }],
    }],
  });

  const projection = calculateShadowProjection({
    asOfDate: "2026-08-31",
    openingCashMinor: 0,
    contributions: result.contributions,
  });
  assert.equal(projection.totalOutflowMinor, 3_107);
  assert.equal(projection.periods[0].contributions.length, 1);
  assert.equal(projection.periods[0].contributions[0].state, "planned");
});
