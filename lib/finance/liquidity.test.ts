import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCreditLiquidity } from "./liquidity.ts";

test("Xero card debt reduces card limits while overdraft limit is added once", () => {
  assert.deepEqual(summarizeCreditLiquidity({
    facilities: [
      { facility_type: "overdraft", credit_limit_minor: 2_000_000, xero_bank_account_type: "BANK", xero_balance_minor: -500_000, xero_balance_source: "bank_summary" },
      { facility_type: "credit_card", credit_limit_minor: 5_000_000, xero_bank_account_type: "CREDITCARD", xero_balance_minor: -1_250_000, xero_balance_source: "bank_summary" },
    ],
  }), {
    creditLimitMinor: 7_000_000,
    creditDrawnMinor: 1_750_000,
    availableCreditMinor: 5_750_000,
  });
});

test("a positive Xero card balance is not treated as debt", () => {
  assert.equal(summarizeCreditLiquidity({
    facilities: [{ facility_type: "credit_card", credit_limit_minor: 1_000_000, xero_bank_account_type: "CREDITCARD", xero_balance_minor: 10_000, xero_balance_source: "bank_summary" }],
  }).availableCreditMinor, 1_000_000);
});

test("a Xero liability balance reduces a working-capital line", () => {
  assert.deepEqual(summarizeCreditLiquidity({
    facilities: [{
      facility_type: "line_of_credit",
      credit_limit_minor: 15_000_000,
      xero_bank_account_type: "LIABILITY",
      xero_balance_minor: 4_250_000,
      xero_balance_source: "balance_sheet",
    }],
  }), {
    creditLimitMinor: 15_000_000,
    creditDrawnMinor: 4_250_000,
    availableCreditMinor: 10_750_000,
  });
});

test("a facility with no Xero balance contributes no available credit", () => {
  assert.equal(summarizeCreditLiquidity({
    facilities: [{
      facility_type: "line_of_credit",
      credit_limit_minor: 15_000_000,
      xero_bank_account_type: "LIABILITY",
      xero_balance_minor: null,
      xero_balance_source: null,
    }],
  }).availableCreditMinor, 0);
});
