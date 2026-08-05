import assert from "node:assert/strict";
import test from "node:test";
import {
  ffeRollup,
  lineClientPrice,
  lineCost,
  lineProfitLoss,
  projectRollup,
} from "./estimate.ts";

test("a stale zero cost override does not block qty times rate", () => {
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 600, cost_ex_gst: 0 }), 2400);
});

test("real manual cost overrides and genuine zero-cost rows are preserved", () => {
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 600, cost_ex_gst: 1800 }), 1800);
  assert.equal(lineCost({ qty: 4, rate_ex_gst: 0, cost_ex_gst: 0 }), 0);
  assert.equal(lineCost({ qty: null, rate_ex_gst: null, cost_ex_gst: 0 }), 0);
});

test("client price follows cost plus default markup until deliberately overridden", () => {
  const automatic = {
    qty: 2,
    rate_ex_gst: 400,
    cost_ex_gst: null,
    quoted_to_client_ex_gst: null,
  };
  assert.equal(lineClientPrice(automatic, 0.3), 1040);
  assert.equal(
    lineClientPrice({ ...automatic, quoted_to_client_ex_gst: 975 }, 0.3),
    975
  );
  assert.equal(
    lineClientPrice({ ...automatic, quoted_to_client_ex_gst: 0 }, 0.3),
    0
  );
});

test("profit or loss uses the automatic client price and approved actual cost", () => {
  const line = {
    qty: 2,
    rate_ex_gst: 400,
    cost_ex_gst: null,
    quoted_to_client_ex_gst: null,
    actual_paid_ex_gst: 900,
  };
  assert.equal(lineProfitLoss(line, 0.3), 140);
  assert.equal(
    lineProfitLoss({ ...line, quoted_to_client_ex_gst: 0 }, 0.3),
    -900
  );
  assert.equal(lineProfitLoss({ ...line, actual_paid_ex_gst: null }, 0.3), null);
});

test("manual client-price overrides flow into the estimate total", () => {
  const rollup = projectRollup({
    lines: [
      {
        qty: 1,
        rate_ex_gst: 1000,
        cost_ex_gst: null,
        quoted_to_client_ex_gst: 1500,
        actual_paid_ex_gst: null,
      },
      {
        qty: 1,
        rate_ex_gst: 500,
        cost_ex_gst: null,
        quoted_to_client_ex_gst: null,
        actual_paid_ex_gst: null,
      },
    ],
    variations: [],
    markupPct: 0.3,
  });

  assert.equal(rollup.allTradesSubtotalExGst, 1500);
  assert.equal(rollup.quotedExGst, 2150);
  assert.equal(rollup.markupExGst, 650);
  assert.equal(rollup.totalToClientExGst, 2150);
});

test("trade-package reference items stay out of FF&E cost rollups", () => {
  const rollup = ffeRollup([
    {
      id: "direct",
      category: "HD",
      quantity: 2,
      price_trade: 10,
      price_rrp: null,
      markup_pct: 30,
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
  assert.equal(rollup.client_total, 26);
  assert.equal(rollup.item_count, 1);
  assert.equal(rollup.categories[0]?.item_count, 1);
  assert.equal(rollup.categories[0]?.client_total, 26);
});

test("legacy/custom FF&E markups remain explicit and RRP stays a placeholder", () => {
  const rollup = ffeRollup([
    {
      id: "legacy",
      category: "FA",
      quantity: 1,
      price_trade: 100,
      price_rrp: null,
      markup_pct: null,
    },
    {
      id: "custom",
      category: "FA",
      quantity: 2,
      price_trade: 50,
      price_rrp: null,
      markup_pct: 10,
    },
    {
      id: "placeholder",
      category: "FA",
      quantity: 1,
      price_trade: null,
      price_rrp: 200,
      markup_pct: 30,
    },
  ]);

  assert.equal(rollup.total, 400);
  assert.equal(rollup.client_total, 410);
});
