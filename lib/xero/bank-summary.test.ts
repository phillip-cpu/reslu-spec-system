import assert from "node:assert/strict";
import test from "node:test";
import { calculateBankSummaryBalance } from "./bank-summary.ts";

test("Bank Summary excludes Xero credit cards from available cash", () => {
  const result = calculateBankSummaryBalance({
    Rows: [{
      RowType: "Section",
      Rows: [
        { Cells: [{ Value: "Bank Accounts" }, { Value: "Opening Balance" }, { Value: "Closing Balance" }] },
        { Cells: [{ Value: "American Express® Qantas Business Rewards Card" }, { Value: "-70,117.26" }] },
        { Cells: [{ Value: "Anz Online Saver" }, { Value: "-318.38" }] },
        { Cells: [{ Value: "Nab Savings" }, { Value: "8.63" }] },
        { Cells: [{ Value: "Reslu Developments" }, { Value: "127.24" }] },
        { Cells: [{ Value: "Reslu Main Account" }, { Value: "1,366.78" }] },
        { Cells: [{ Value: "Reslu Tax Gst" }, { Value: "9,909.21" }] },
        { Cells: [{ Value: "Total" }, { Value: "-59,023.78" }] },
      ],
    }],
  }, [
    { name: "American Express® Qantas Business Rewards Card", bankAccountType: "CREDITCARD" },
    { name: "Anz Online Saver", bankAccountType: "BANK" },
    { name: "Nab Savings", bankAccountType: "BANK" },
    { name: "Reslu Developments", bankAccountType: "BANK" },
    { name: "Reslu Main Account", bankAccountType: "BANK" },
    { name: "Reslu Tax Gst", bankAccountType: "BANK" },
  ]);

  assert.equal(result.cashBalance, 11_093.48);
  assert.equal(result.creditBalance, -70_117.26);
  assert.equal(result.cashAccountCount, 5);
  assert.equal(result.creditAccountCount, 1);
  assert.equal(result.unmatchedAccountCount, 0);
});
