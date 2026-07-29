import assert from "node:assert/strict";
import test from "node:test";
import { calculateProjectFinancialPosition } from "./project-financial-position";

test("separates approved costs, issued invoices, receipts and outstanding invoices", () => {
  const result = calculateProjectFinancialPosition({
    supplierInvoices: [
      { status: "approved", amount_ex_gst: 1000, total: 1100 },
      { status: "approved", amount_ex_gst: 500, total: 550 },
      { status: "proposed", amount_ex_gst: 9999, total: 10998.9 },
      { status: "voided", amount_ex_gst: 800, total: 880 },
    ],
    clientInvoices: [
      { status: "paid", subtotal_ex_gst: 2000, total_inc_gst: 2200 },
      { status: "sent", subtotal_ex_gst: 1000, total_inc_gst: 1100 },
      { status: "draft", subtotal_ex_gst: 400, total_inc_gst: 440 },
      { status: "void", subtotal_ex_gst: 9000, total_inc_gst: 9900 },
    ],
    originalContractIncGst: 11000,
    approvedVariationsExGst: 1000,
    plannedCostExGst: 7000,
  });

  assert.deepEqual(result.supplier_approved, {
    count: 2,
    total_ex_gst: 1500,
    total_inc_gst: 1650,
  });
  assert.equal(result.client_issued.count, 2);
  assert.equal(result.client_issued.total_ex_gst, 3000);
  assert.equal(result.client_paid.count, 1);
  assert.equal(result.client_outstanding.count, 1);
  assert.equal(result.client_drafts.count, 1);
  assert.equal(result.current_recorded_position_ex_gst, 1500);
});

test("uses the higher of planned costs and approved costs for forecast", () => {
  const result = calculateProjectFinancialPosition({
    supplierInvoices: [
      { status: "approved", amount_ex_gst: 12000, total: 13200 },
    ],
    clientInvoices: [],
    originalContractIncGst: 11000,
    approvedVariationsExGst: 0,
    plannedCostExGst: 8000,
  });

  assert.equal(result.forecast_cost_ex_gst, 12000);
  assert.equal(result.forecast_margin_ex_gst, -2000);
  assert.equal(result.forecast_margin_pct, -20);
  assert.equal(result.status, "at_risk");
});

test("identifies when approved costs are ahead of client billing", () => {
  const result = calculateProjectFinancialPosition({
    supplierInvoices: [
      { status: "approved", amount_ex_gst: 6000, total: 6600 },
    ],
    clientInvoices: [
      { status: "sent", subtotal_ex_gst: 2000, total_inc_gst: 2200 },
    ],
    originalContractIncGst: 11000,
    approvedVariationsExGst: 0,
    plannedCostExGst: 8000,
  });

  assert.equal(result.billing_progress_pct, 20);
  assert.equal(result.cost_progress_pct, 75);
  assert.equal(result.progress_gap_points, -55);
  assert.equal(result.status, "costs_ahead");
});

test("identifies when client billing is ahead of approved costs", () => {
  const result = calculateProjectFinancialPosition({
    supplierInvoices: [
      { status: "approved", amount_ex_gst: 1000, total: 1100 },
    ],
    clientInvoices: [
      { status: "paid", subtotal_ex_gst: 7000, total_inc_gst: 7700 },
    ],
    originalContractIncGst: 11000,
    approvedVariationsExGst: 0,
    plannedCostExGst: 8000,
  });

  assert.equal(result.billing_progress_pct, 70);
  assert.equal(result.cost_progress_pct, 12.5);
  assert.equal(result.status, "billing_ahead");
});

test("requires both a contract and cost plan before judging the job", () => {
  const result = calculateProjectFinancialPosition({
    supplierInvoices: [],
    clientInvoices: [],
    originalContractIncGst: null,
    approvedVariationsExGst: 0,
    plannedCostExGst: 0,
  });

  assert.equal(result.status, "needs_setup");
  assert.equal(result.forecast_margin_pct, null);
  assert.equal(result.billing_progress_pct, null);
  assert.equal(result.cost_progress_pct, null);
});

test("approved variations alone do not count as a configured original contract", () => {
  const result = calculateProjectFinancialPosition({
    supplierInvoices: [],
    clientInvoices: [],
    originalContractIncGst: null,
    approvedVariationsExGst: 1000,
    plannedCostExGst: 500,
  });

  assert.equal(result.contract_configured, false);
  assert.equal(result.status, "needs_setup");
  assert.match(result.story, /contract value/i);
});
