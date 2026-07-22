import assert from "node:assert/strict";
import test from "node:test";
import { lineCost } from "./estimate.ts";

test("a stale zero cost override does not block qty times rate", () => {
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 600, cost_ex_gst: 0 }), 2400);
});

test("real manual cost overrides and genuine zero-cost rows are preserved", () => {
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 600, cost_ex_gst: 1800 }), 1800);
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 0, cost_ex_gst: 0 }), 0);
  assert.equal(lineCost({ qty: null, rate_ex_gst: null, cost_ex_gst: 0 }), 0);
});
