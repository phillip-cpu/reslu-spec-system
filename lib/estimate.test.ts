import assert from "node:assert/strict";
import test from "node:test";
import { ffeRollup, lineCost } from "./estimate.ts";

test("a stale zero cost override does not block qty times rate", () => {
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 600, cost_ex_gst: 0 }), 2400);
});

test("real manual cost overrides and genuine zero-cost rows are preserved", () => {
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 600, cost_ex_gst: 1800 }), 1800);
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 0, cost_ex_gst: 0 }), 0);
  assert.equal(lineCost({ qty: null, rate_ex_gst: null, cost_ex_gst: 0 }), 0);
});

test("trade-package reference items stay out of FF&E cost rollups", () => {
  const rollup = ffeRollup([
    {
      id: "direct",
      category: "HD",
      quantity: 2,
      price_trade: 10,
      price_rrp: null,
      cost_scope: "direct",
    },
    {
      id: "joiner-package",
      category: "HD",
      quantity: 20,
      price_trade: 50,
      price_rrp: null,
      cost_scope: "trade_package",
    },
  ]);

  assert.equal(rollup.total, 20);
  assert.equal(rollup.item_count, 1);
  assert.equal(rollup.categories[0]?.item_count, 1);
});
