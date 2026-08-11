import assert from "node:assert/strict";
import test from "node:test";
import { XERO_REPORTS, xeroReportDefinition } from "./report-definitions.ts";

test("Xero report list exposes the core RESLU read-only reports", () => {
  assert.deepEqual(
    XERO_REPORTS.map((report) => report.key),
    [
      "profit_and_loss",
      "balance_sheet",
      "trial_balance",
      "bank_summary",
      "budget_summary",
      "executive_summary",
      "bas",
    ]
  );
  assert.equal(xeroReportDefinition("profit_and_loss")?.endpoint, "ProfitAndLoss");
  assert.equal(xeroReportDefinition("unknown"), null);
});
