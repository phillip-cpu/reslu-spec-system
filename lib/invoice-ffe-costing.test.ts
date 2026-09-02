import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvoiceFfeCostingRows,
  invoiceSupplierMatches,
  type InvoiceFfeCostingItemInput,
} from "./invoice-ffe-costing.ts";

const baseItem: InvoiceFfeCostingItemInput = {
  id: "tap",
  item_code: "TW-01",
  name: "Basin mixer",
  category: "TW",
  supplier: "Reece",
  quantity: 2,
  unit: "ea",
  cost_scope: "direct",
  status: "Quoted",
  ordered_at: null,
  price_trade: 100,
  price_rrp: 140,
  measurement_id: null,
  wastage_pct: null,
  coverage_per_unit: null,
};

test("supplier matching tolerates common Australian company suffixes", () => {
  assert.equal(invoiceSupplierMatches("Reece Australia Pty Ltd", "Reece"), true);
  assert.equal(invoiceSupplierMatches("Reece", "Verandah Trade"), false);
});

test("saved estimate stays the benchmark while approved actuals reduce its remaining value", () => {
  const [row] = buildInvoiceFfeCostingRows({
    items: [baseItem],
    components: [],
    snapshotItems: [{ id: "tap", cost_net_minor: 25_000 }],
    approvedAllocations: [{
      invoice_id: "invoice-1",
      match_type: "item",
      match_id: "tap",
      amount_ex_gst: 175,
    }],
  });
  assert.equal(row.current_expected_ex_gst, 200);
  assert.equal(row.forecast_ex_gst, 250);
  assert.equal(row.forecast_source, "saved_estimate");
  assert.equal(row.approved_actual_ex_gst, 175);
  assert.equal(row.remaining_forecast_ex_gst, 75);
  assert.equal(row.variance_ex_gst, -75);
});

test("legacy snapshots visibly fall back to the live measurement-derived schedule", () => {
  const [row] = buildInvoiceFfeCostingRows({
    items: [{
      ...baseItem,
      quantity: 1,
      measurement_id: "m1",
      wastage_pct: 10,
      coverage_per_unit: 2,
    }],
    components: [],
    measurements: { m1: 8 },
  });
  assert.equal(row.quantity, 5);
  assert.equal(row.current_expected_ex_gst, 500);
  assert.equal(row.forecast_ex_gst, 500);
  assert.equal(row.forecast_source, "live_schedule");
});

test("trade-package references never appear as invoiceable FF&E", () => {
  const rows = buildInvoiceFfeCostingRows({
    items: [{ ...baseItem, id: "reference", cost_scope: "trade_package" }],
    components: [],
  });
  assert.deepEqual(rows, []);
});

test("component actuals roll into the parent total and retain component detail", () => {
  const rows = buildInvoiceFfeCostingRows({
    items: [baseItem],
    components: [{
      id: "cartridge",
      item_id: "tap",
      name: "Mixer cartridge",
      supplier: "Verandah Trade",
      supplier_item_code: "C-01",
      quantity_per_item: 1,
      unit: "ea",
      price_trade: 80,
      ordered_at: null,
    }],
    approvedAllocations: [{
      invoice_id: "invoice-2",
      match_type: "item_component",
      match_id: "cartridge",
      amount_ex_gst: 146.36,
    }],
  });
  const parent = rows.find((row) => row.match_type === "item");
  const component = rows.find((row) => row.match_type === "item_component");
  assert.equal(parent?.approved_actual_ex_gst, 146.36);
  assert.equal(parent?.approved_invoice_count, 1);
  assert.equal(component?.quantity, 2);
  assert.equal(component?.current_expected_ex_gst, 160);
  assert.equal(component?.approved_actual_ex_gst, 146.36);
});

test("archived components stay out of matching but their historical actual still reduces the parent", () => {
  const rows = buildInvoiceFfeCostingRows({
    items: [baseItem],
    components: [{
      id: "archived-cartridge",
      item_id: "tap",
      name: "Old cartridge",
      supplier: "Supplier",
      supplier_item_code: null,
      quantity_per_item: 1,
      unit: "ea",
      price_trade: 50,
      ordered_at: null,
      deleted_at: "2026-08-01T00:00:00Z",
    }],
    approvedAllocations: [{
      invoice_id: "invoice-archived",
      match_type: "item_component",
      match_id: "archived-cartridge",
      amount_ex_gst: 70,
    }],
  });
  assert.equal(rows.some((row) => row.match_id === "archived-cartridge"), false);
  assert.equal(rows.find((row) => row.match_type === "item")?.approved_actual_ex_gst, 70);
});

test("cost-line matches linked to an FF&E item are included in its approved actual", () => {
  const [row] = buildInvoiceFfeCostingRows({
    items: [baseItem],
    components: [],
    costLineItemIds: { line: "tap" },
    approvedAllocations: [{
      invoice_id: "invoice-3",
      match_type: "cost_line",
      match_id: "line",
      amount_ex_gst: 90,
    }],
  });
  assert.equal(row.approved_actual_ex_gst, 90);
  assert.equal(row.approved_invoice_count, 1);
});
