import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FFE_MARKUP_PERCENT,
  ffeClientQuoteUnitPrice,
  ffeProductCostUnitPrice,
} from "./ffe-pricing.ts";

test("new FF&E pricing defaults to a 30 percent markup", () => {
  assert.equal(DEFAULT_FFE_MARKUP_PERCENT, 30);
  assert.equal(
    ffeClientQuoteUnitPrice({ price_trade: 100, price_rrp: 160, markup_pct: 30 }),
    130
  );
});

test("intentional and legacy markup values remain authoritative", () => {
  assert.equal(
    ffeClientQuoteUnitPrice({ price_trade: 100, price_rrp: null, markup_pct: 12.5 }),
    112.5
  );
  assert.equal(
    ffeClientQuoteUnitPrice({ price_trade: 100, price_rrp: null, markup_pct: null }),
    100
  );
});

test("RRP placeholders receive item markup while trade packages stay excluded", () => {
  assert.equal(
    ffeClientQuoteUnitPrice({ price_trade: null, price_rrp: 180, markup_pct: 30 }),
    234
  );
  assert.equal(
    ffeClientQuoteUnitPrice({
      price_trade: 100,
      price_rrp: null,
      markup_pct: 30,
      cost_scope: "trade_package",
    }),
    null
  );
});

test("product cost follows the same trade then RRP placeholder cascade", () => {
  assert.equal(
    ffeProductCostUnitPrice({ price_trade: 100, price_rrp: 180, markup_pct: 30 }),
    100
  );
  assert.equal(
    ffeProductCostUnitPrice({ price_trade: null, price_rrp: 180, markup_pct: 30 }),
    180
  );
  assert.equal(
    ffeProductCostUnitPrice({ price_trade: null, price_rrp: null, markup_pct: 30 }),
    null
  );
  assert.equal(
    ffeProductCostUnitPrice({
      price_trade: 100,
      price_rrp: 180,
      markup_pct: 30,
      cost_scope: "trade_package",
    }),
    null
  );
});

test("placeholder markup preserves zero, missing, custom rates and missing costs", () => {
  for (const markup_pct of [0, null, undefined]) {
    assert.equal(ffeClientQuoteUnitPrice({ price_trade: null, price_rrp: 80, markup_pct }), 80);
  }
  assert.equal(ffeClientQuoteUnitPrice({ price_trade: null, price_rrp: 80, markup_pct: 12.5 }), 90);
  assert.equal(ffeClientQuoteUnitPrice({ price_trade: null, price_rrp: null, markup_pct: 30 }), null);
  assert.equal(ffeClientQuoteUnitPrice({ price_trade: 0, price_rrp: 80, markup_pct: 30 }), 0);
  assert.equal(ffeClientQuoteUnitPrice({ price_trade: null, price_rrp: 80, markup_pct: 30, cost_scope: "trade_package" }), null);
});
