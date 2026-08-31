import assert from "node:assert/strict";
import test from "node:test";
import { xeroReportAccountBalances } from "./report-account-balances.ts";

test("extracts an exact liability account from a nested Xero Balance Sheet", () => {
  const balances = xeroReportAccountBalances({
    Rows: [{
      RowType: "Section",
      Title: "Current Liabilities",
      Rows: [
        { Cells: [{ Value: "Shift Credit Line" }, { Value: "42,345.67" }] },
        { Cells: [{ Value: "Total Current Liabilities" }, { Value: "50,000.00" }] },
      ],
    }],
  }, ["Shift Credit Line"]);

  assert.deepEqual(balances, [{ name: "Shift Credit Line", balance: 42_345.67 }]);
});

test("parses parenthesized report balances without fuzzy account matches", () => {
  const balances = xeroReportAccountBalances({
    Rows: [
      { Cells: [{ Value: "Shift Credit Line" }, { Value: "(1,250.00)" }] },
      { Cells: [{ Value: "Shift Credit Line Fees" }, { Value: "100.00" }] },
    ],
  }, ["Shift Credit Line"]);

  assert.deepEqual(balances, [{ name: "Shift Credit Line", balance: -1_250 }]);
});
