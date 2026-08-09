import assert from "node:assert/strict";
import test from "node:test";
import { buildEstimatePlanContributions } from "./baseline.ts";

const snapshot = {
  sections: [
    {
      id: "section-electrical",
      name: "Electrical",
      lines: [
        {
          id: "line-calculated",
          description: "Calculated line",
          qty: 4,
          rate_ex_gst: 600,
          cost_ex_gst: 0,
        },
        {
          id: "line-explicit",
          description: "Lump sum",
          qty: 4,
          rate_ex_gst: 600,
          cost_ex_gst: 1800,
        },
      ],
    },
  ],
  ffe: {
    categories: [
      {
        category: "FA",
        total: 1250.55,
        placeholder_count: 1,
        unpriced_count: 0,
      },
    ],
  },
  rollup: { approvedVariationsExGst: 500 },
};

test("saved estimate converts to cent-exact contribution identities", () => {
  const result = buildEstimatePlanContributions({
    projectId: "project-1",
    estimateVersionId: "estimate-v1",
    snapshot,
  });
  assert.deepEqual(
    result.map((item) => [item.description, item.plannedMinor]),
    [
      ["Calculated line", 240_000],
      ["Lump sum", 180_000],
      ["FF&E - FA", 125_055],
      ["Approved variations", 50_000],
    ]
  );
  assert.equal(new Set(result.map((item) => item.contributionKey)).size, result.length);
  assert.ok(result.every((item) => item.plannedDate === null));
});

test("shadow timing overrides are isolated and typo-safe", () => {
  const key = "project:project-1|cost_line:line-calculated|scope:base";
  const result = buildEstimatePlanContributions({
    projectId: "project-1",
    estimateVersionId: "estimate-v1",
    snapshot,
    timingOverrides: { [key]: "2026-08-24" },
  });
  assert.equal(result.find((item) => item.contributionKey === key)?.plannedDate, "2026-08-24");
  assert.throws(
    () =>
      buildEstimatePlanContributions({
        projectId: "project-1",
        estimateVersionId: "estimate-v1",
        snapshot,
        timingOverrides: { typo: "2026-08-24" },
      }),
    /Unknown timing override/
  );
});

test("construction schedule dates drive every cost line in a linked estimate section", () => {
  const result = buildEstimatePlanContributions({
    projectId: "project-1",
    estimateVersionId: "estimate-v1",
    snapshot,
    sectionDates: { "section-electrical": "2026-09-11" },
  });
  const electrical = result.filter(
    (item) => item.sourceTrace?.section_id === "section-electrical"
  );
  assert.equal(electrical.length, 2);
  assert.ok(electrical.every((item) => item.plannedDate === "2026-09-11"));
  assert.ok(electrical.every((item) => item.confidence === "medium"));
  assert.ok(
    electrical.every(
      (item) => item.sourceTrace?.timing_source === "construction_schedule"
    )
  );
});

test("legacy preview overrides still take precedence over the construction schedule", () => {
  const key = "project:project-1|cost_line:line-calculated|scope:base";
  const result = buildEstimatePlanContributions({
    projectId: "project-1",
    estimateVersionId: "estimate-v1",
    snapshot,
    sectionDates: { "section-electrical": "2026-09-11" },
    timingOverrides: { [key]: "2026-09-18" },
  });
  const overridden = result.find((item) => item.contributionKey === key);
  assert.equal(overridden?.plannedDate, "2026-09-18");
  assert.equal(overridden?.sourceTrace?.timing_source, "shadow_override");
});
