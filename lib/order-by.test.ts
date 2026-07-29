import assert from "node:assert/strict";
import test from "node:test";
import { deriveOrderBy, missingLeadTimes } from "./order-by.ts";

test("trade-package reference items do not enter ordering workflows", () => {
  const items = [
    {
      id: "hardware",
      project_id: "project-1",
      category: "HD",
      lead_time_weeks: null,
      ordered_at: null,
      cost_scope: "trade_package" as const,
    },
  ];

  assert.deepEqual(deriveOrderBy(items, [], [], []), []);
  assert.deepEqual(missingLeadTimes(items), []);
});
