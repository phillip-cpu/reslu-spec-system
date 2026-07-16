import assert from "node:assert/strict";
import test from "node:test";
import { validateSupplierInvoiceLines } from "./supplier-invoice-lines.ts";

const bunningsLines = [
  { supplier_item_code: "9920161", description: "Standard metro UTE delivery", quantity: 1, unit: "EACH", unit_price_ex_gst: 50, amount_ex_gst: 50, gst: 5, amount_inc_gst: 55 },
  { supplier_item_code: "3063570", description: "Lattice stakes 25×25mm 1200mm PK6", quantity: 1, unit: "EACH", unit_price_ex_gst: 16.4, amount_ex_gst: 16.4, gst: 1.64, amount_inc_gst: 18.04 },
  { supplier_item_code: "1038104", description: "Barrier mesh 900mm × 50m", quantity: 1, unit: "EACH", unit_price_ex_gst: 25.05, amount_ex_gst: 25.05, gst: 2.5, amount_inc_gst: 27.55 },
  { supplier_item_code: "3332296", description: "Heavy-duty tarpaulin 3.0 × 3.6m", quantity: 1, unit: "EACH", unit_price_ex_gst: 33.76, amount_ex_gst: 33.76, gst: 3.38, amount_inc_gst: 37.14 },
  { supplier_item_code: "0400888", description: "Builders Edge carpet protective film", quantity: 2, unit: "EACH", unit_price_ex_gst: 44.31, amount_ex_gst: 88.62, gst: 8.86, amount_inc_gst: 97.48 },
  { supplier_item_code: "1214167", description: "ScotchBlue masking tape", quantity: 3, unit: "EACH", unit_price_ex_gst: 12.26, amount_ex_gst: 36.79, gst: 3.68, amount_inc_gst: 40.47 },
  { supplier_item_code: "0948816", description: "RamBoard door jamb protector", quantity: 5, unit: "EACH", unit_price_ex_gst: 16.46, amount_ex_gst: 82.32, gst: 8.23, amount_inc_gst: 90.55 },
  { supplier_item_code: "1090814", description: "RamBoard 72mm tape", quantity: 1, unit: "EACH", unit_price_ex_gst: 19.09, amount_ex_gst: 19.09, gst: 1.91, amount_inc_gst: 21 },
  { supplier_item_code: "1090813", description: "RamBoard temporary floor protection", quantity: 2, unit: "EACH", unit_price_ex_gst: 115.87, amount_ex_gst: 231.75, gst: 23.17, amount_inc_gst: 254.92 },
  { supplier_item_code: "0712284", description: "Eco-caterpillar killer 40g", quantity: 1, unit: "EACH", unit_price_ex_gst: 20.87, amount_ex_gst: 20.87, gst: 2.09, amount_inc_gst: 22.96 },
];

test("accepts the exact ten Bunnings lines despite supplier rounding", () => {
  const result = validateSupplierInvoiceLines(bunningsLines, 604.65);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lines.length, 10);
    assert.equal(result.line_total_cents, 60_465);
    assert.equal(result.lines[6].amount_ex_gst, 82.32);
  }
});

test("rejects source lines that do not reconcile to the invoice", () => {
  const result = validateSupplierInvoiceLines(
    [{ description: "One line", quantity: 1, amount_ex_gst: 99.99 }],
    100
  );
  assert.deepEqual(result, {
    ok: false,
    error: "Supplier lines are under the invoice ex-GST total by $0.01",
  });
});

test("validates paired project suggestions", () => {
  const invalid = validateSupplierInvoiceLines(
    [{ description: "Tap", quantity: 1, amount_ex_gst: 100, suggested_match_type: "item" }],
    100
  );
  const valid = validateSupplierInvoiceLines(
    [{ description: "Tap", quantity: 1, amount_ex_gst: 100, suggested_match_type: "item", suggested_match_id: "item-1", apply_to_library_cost: true }],
    100
  );
  assert.equal(invalid.ok, false);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.lines[0].apply_to_library_cost, true);
});
