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
      ["Calculated line", 264_000],
      ["Lump sum", 198_000],
      ["FF&E - FA", 137_561],
      ["Approved variations", 55_000],
    ]
  );
  assert.equal(new Set(result.map((item) => item.contributionKey)).size, result.length);
  assert.ok(result.every((item) => item.plannedDate === null));
  assert.ok(result.every((item) => item.sourceTrace?.cash_basis === "gross_inc_gst"));
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

test("new estimate snapshots forecast FF&E by item using live procurement timing", () => {
  const result = buildEstimatePlanContributions({
    projectId: "project-1",
    estimateVersionId: "estimate-v2",
    snapshot: {
      sections: [],
      ffe: { categories: [{ category: "TW", total: 500 }] },
      ffe_items: [{
        id: "item-tap",
        item_code: "TW-01",
        name: "Basin mixer",
        category: "TW",
        quantity: 2,
        cost_scope: "direct",
        unit_price_ex_gst: 250,
        total_ex_gst: 500,
        pricing_confidence: "quoted",
      }],
    },
    itemTimings: {
      "item-tap": {
        plannedDate: "2026-09-03",
        timingSource: "trade_order_by",
        confidence: "medium",
        orderByStatus: "ok",
        worksDate: "2026-09-24",
        tradeName: "Plumber",
        sourceId: "visit-1",
        sourceKind: "visit",
      },
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].contributionKey, "project:project-1|ffe_item:item-tap|scope:base");
  assert.equal(result[0].plannedMinor, 55_000);
  assert.equal(result[0].plannedDate, "2026-09-03");
  assert.equal(result[0].sourceTrace?.timing_source, "trade_order_by");
  assert.equal(result[0].sourceTrace?.trade_name, "Plumber");
});

test("legacy FF&E category override can transition to item-level snapshots", () => {
  const categoryKey = "project:project-1|ffe_category:TW|scope:base";
  const result = buildEstimatePlanContributions({
    projectId: "project-1",
    estimateVersionId: "estimate-v2",
    snapshot: {
      sections: [],
      ffe_items: [{
        id: "item-tap",
        category: "TW",
        total_ex_gst: 100,
        pricing_confidence: "placeholder",
      }],
    },
    timingOverrides: { [categoryKey]: "2026-09-10" },
  });
  assert.equal(result[0].plannedDate, "2026-09-10");
  assert.equal(result[0].confidence, "low");
  assert.equal(result[0].sourceTrace?.timing_source, "shadow_override");
});
