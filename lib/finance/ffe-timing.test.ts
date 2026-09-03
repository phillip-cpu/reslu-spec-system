import assert from "node:assert/strict";
import test from "node:test";
import { buildFfeForecastTimings, summarizeFfePricing } from "./ffe-timing.ts";

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

test("FF&E pricing summary separates quotes, placeholders and missing prices", () => {
  assert.deepEqual(summarizeFfePricing([
    { cost_scope: "direct", price_trade: 120, price_rrp: 150 },
    { cost_scope: "direct", price_trade: null, price_rrp: 80 },
    { cost_scope: "direct", price_trade: null, price_rrp: null },
    { cost_scope: "trade_package", price_trade: null, price_rrp: null },
  ]), {
    directItemCount: 3,
    quotedItemCount: 1,
    placeholderItemCount: 1,
    unpricedItemCount: 1,
  });
});
