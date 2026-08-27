import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCreditLiquidity } from "./liquidity.ts";

test("Xero card debt reduces card limits while overdraft limit is added once", () => {
  assert.deepEqual(summarizeCreditLiquidity({
    facilities: [
      { facility_type: "overdraft", credit_limit_minor: 2_000_000 },
      { facility_type: "credit_card", credit_limit_minor: 5_000_000 },
    ],
    xeroCreditBalanceDollars: -12_500,
  }), {
    creditLimitMinor: 7_000_000,
    creditDrawnMinor: 1_250_000,
    availableCreditMinor: 5_750_000,
  });
});

test("a positive Xero card balance is not treated as debt", () => {
  assert.equal(summarizeCreditLiquidity({
    facilities: [{ facility_type: "credit_card", credit_limit_minor: 1_000_000 }],
    xeroCreditBalanceDollars: 100,
  }).availableCreditMinor, 1_000_000);
});
