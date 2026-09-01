import assert from "node:assert/strict";
import test from "node:test";
import { calculateShadowProjection } from "./projection.ts";
import { cashCommitmentContributions, estimateAllowanceSummary } from "./scenarios.ts";

test("cash view excludes estimate allowances but keeps supplier actuals and overheads", () => {
  const contributions = [
    {
      contributionKey: "estimate",
      direction: "outflow" as const,
      description: "Uncommitted joinery allowance",
      plannedMinor: 100_000,
      plannedDate: "2026-09-01",
      sourceTrace: { source_type: "estimate_cost_line" },
    },
    {
      contributionKey: "bill",
      direction: "outflow" as const,
      description: "Supplier bill",
      plannedMinor: 0,
      actualAccruedMinor: 20_000,
      actualPaidMinor: 0,
      actualDueDate: "2026-09-01",
      sourceTrace: { source_type: "supplier_invoice_allocation" },
    },
    {
      contributionKey: "ffe-item",
      direction: "outflow" as const,
      description: "Uncommitted tapware allowance",
      plannedMinor: 40_000,
      plannedDate: "2026-09-01",
      sourceTrace: { source_type: "estimate_ffe_item" },
    },
    {
      contributionKey: "wages",
      direction: "outflow" as const,
      description: "Wages",
      plannedMinor: 30_000,
      plannedDate: "2026-09-01",
      sourceTrace: { source: "recurring_commitment" },
    },
  ];
  const projection = calculateShadowProjection({
    asOfDate: "2026-09-01",
    openingCashMinor: 200_000,
    contributions: cashCommitmentContributions(contributions),
  });
  assert.equal(projection.totalOutflowMinor, 50_000);
});

test("allowance summary separates overdue and undated estimate exposure", () => {
  const projection = calculateShadowProjection({
    asOfDate: "2026-09-02",
    openingCashMinor: 0,
    contributions: [
      { contributionKey: "old", direction: "outflow", description: "Old", plannedMinor: 10_000, plannedDate: "2026-08-01", sourceTrace: { source_type: "estimate_cost_line" } },
      { contributionKey: "unknown", direction: "outflow", description: "Unknown", plannedMinor: 20_000, sourceTrace: { source_type: "estimate_ffe_category" } },
      { contributionKey: "item", direction: "outflow", description: "Tapware", plannedMinor: 40_000, plannedDate: "2026-09-10", sourceTrace: { source_type: "estimate_ffe_item" } },
    ],
  });
  assert.deepEqual(estimateAllowanceSummary(projection), {
    totalMinor: 70_000,
    datedMinor: 50_000,
    undatedMinor: 20_000,
    overdueMinor: 10_000,
    itemCount: 3,
  });
});
