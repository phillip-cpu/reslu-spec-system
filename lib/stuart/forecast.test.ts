import assert from "node:assert/strict";
import test from "node:test";
import { buildThirteenWeekForecast, summariseProjectCosts } from "./forecast.ts";

test("builds base and delayed-receipt cash paths without inventing payments", () => {
  const result = buildThirteenWeekForecast(10_000, [
    { invoice_type: "ACCREC", status: "AUTHORISED", due_date: "2026-08-13", amount_due: 5_000 },
    { invoice_type: "ACCPAY", status: "AUTHORISED", due_date: "2026-08-14", amount_due: 2_000 },
  ], "2026-08-12");
  assert.equal(result.weeks[0].closing_cash_base, 13_000);
  assert.equal(result.weeks[0].closing_cash_downside, 8_000);
  assert.equal(result.weeks[2].closing_cash_downside, 13_000);
});

test("summarises historical estimate, quote and approved actual cost evidence", () => {
  const [summary] = summariseProjectCosts([
    { project_id: "p1", cost_ex_gst: 100, quoted_to_client_ex_gst: 150, actual_paid_ex_gst: 120 },
    { project_id: "p1", cost_ex_gst: 50, quoted_to_client_ex_gst: 80, actual_paid_ex_gst: null },
  ]);
  assert.equal(summary.estimated_cost_ex_gst, 150);
  assert.equal(summary.actual_ex_gst, 120);
  assert.equal(summary.actual_vs_estimated_ex_gst, -30);
  assert.equal(summary.lines_with_actuals, 1);
});
