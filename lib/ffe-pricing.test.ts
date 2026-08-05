import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FFE_MARKUP_PERCENT,
  ffeClientQuoteUnitPrice,
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

test("RRP placeholders, trade packages and reusable costs are not marked up", () => {
  assert.equal(
    ffeClientQuoteUnitPrice({ price_trade: null, price_rrp: 180, markup_pct: 30 }),
    180
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
