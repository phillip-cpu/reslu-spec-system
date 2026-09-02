import assert from "node:assert/strict";
import test from "node:test";
import { buildFfeForecastTimings } from "./ffe-timing.ts";

test("ordered items use the recorded order date as the strongest timing signal", () => {
  const timings = buildFfeForecastTimings([
    {
      id: "ordered",
      project_id: "p1",
      category: "TW",
      lead_time_weeks: 3,
      ordered_at: "2026-08-12",
      cost_scope: "direct",
    },
  ], []);
  assert.deepEqual(timings.ordered, {
    plannedDate: "2026-08-12",
    timingSource: "ordered_at",
    confidence: "high",
    orderByStatus: "ordered",
    worksDate: null,
    tradeName: null,
    sourceId: null,
    sourceKind: null,
  });
});

test("unordered items inherit the procurement engine's trade-linked order-by date", () => {
  const timings = buildFfeForecastTimings([
    {
      id: "tap",
      project_id: "p1",
      category: "TW",
      lead_time_weeks: 3,
      ordered_at: null,
      cost_scope: "direct",
    },
  ], [{
    item_id: "tap",
    status: "ok",
    order_by: "2026-09-03",
    works_date: "2026-09-24",
    source: {
      source_id: "visit-1",
      source_kind: "visit",
      project_id: "p1",
      contact_id: "plumber-1",
      start_date: "2026-09-24",
    },
    matched_preset: { name: "Plumber", prefixes: ["TW"] },
  }]);
  assert.equal(timings.tap.plannedDate, "2026-09-03");
  assert.equal(timings.tap.timingSource, "trade_order_by");
  assert.equal(timings.tap.tradeName, "Plumber");
  assert.equal(timings.tap.worksDate, "2026-09-24");
});

test("Finance preserves the selected Work activity and trade role", () => {
  const timings = buildFfeForecastTimings([
    {
      id: "mixer",
      project_id: "p1",
      category: "TW",
      lead_time_weeks: 3,
      ordered_at: null,
      cost_scope: "direct",
    },
  ], [{
    item_id: "mixer",
    status: "ok",
    order_by: "2026-10-07",
    works_date: "2026-10-30",
    source: {
      source_id: "rough-in-task",
      source_kind: "board_task_requirement",
      project_id: "p1",
      contact_id: null,
      start_date: "2026-10-30",
    },
    matched_preset: null,
    timing_basis: "required_activity",
    required_activity_id: "rough-in-task",
    required_activity_title: "Plumbing rough-in",
    required_trade_role: "Plumber",
    buffer_days: 2,
  }]);

  assert.equal(timings.mixer.plannedDate, "2026-10-07");
  assert.equal(timings.mixer.tradeName, "Plumber");
  assert.equal(timings.mixer.sourceKind, "board_task_requirement");
  assert.equal(timings.mixer.sourceId, "rough-in-task");
});

test("missing lead times and bookings remain explicitly undated", () => {
  const items = [
    { id: "lead", project_id: "p1", category: "TW", lead_time_weeks: null, ordered_at: null, cost_scope: "direct" as const },
    { id: "booking", project_id: "p1", category: "AP", lead_time_weeks: 4, ordered_at: null, cost_scope: "direct" as const },
    { id: "package", project_id: "p1", category: "HW", lead_time_weeks: null, ordered_at: null, cost_scope: "trade_package" as const },
  ];
  const timings = buildFfeForecastTimings(items, [
    { item_id: "lead", status: "no_lead_time", order_by: null, works_date: "2026-09-24", source: null, matched_preset: null },
    { item_id: "booking", status: "no_booking", order_by: null, works_date: null, source: null, matched_preset: null },
  ]);
  assert.equal(timings.lead.timingSource, "no_lead_time");
  assert.equal(timings.lead.plannedDate, null);
  assert.equal(timings.booking.timingSource, "no_booking");
  assert.equal(timings.package, undefined);
});
