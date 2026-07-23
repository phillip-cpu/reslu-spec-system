import assert from "node:assert/strict";
import test from "node:test";
import {
  assemblyProcurementLabel,
  assemblyProcurementStatus,
  assemblyUnitCost,
} from "./item-components.ts";

test("assembly cost totals each component quantity without rounding drift", () => {
  assert.equal(
    assemblyUnitCost([
      { quantity_per_item: 1, price_trade: 79.55 },
      { quantity_per_item: 1, price_trade: 54.09 },
      { quantity_per_item: 2, price_trade: 3.333 },
    ]),
    140.31
  );
  assert.equal(
    assemblyUnitCost([
      { quantity_per_item: 1, price_trade: 79.55 },
      { quantity_per_item: 1, price_trade: null },
    ]),
    null
  );
  assert.equal(assemblyUnitCost([]), null);
});

test("assembly status distinguishes partial ordering and delivery", () => {
  const components = [
    { ordered_at: "2026-07-24", delivered_at: null },
    { ordered_at: null, delivered_at: null },
  ];
  assert.equal(assemblyProcurementStatus(components), "partially_ordered");
  assert.equal(assemblyProcurementLabel(components), "1/2 parts ordered");

  assert.equal(
    assemblyProcurementStatus([
      { ordered_at: "2026-07-24", delivered_at: "2026-08-01" },
      { ordered_at: "2026-07-24", delivered_at: null },
    ]),
    "partially_delivered"
  );
});
