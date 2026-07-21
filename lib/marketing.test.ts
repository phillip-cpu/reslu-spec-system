import assert from "node:assert/strict";
import test from "node:test";
import {
  adelaideUtcRange,
  defaultMarketingRange,
  EXCLUDED_MARKETING_LEAD_STAGE,
  marketingPresetFrom,
  mergeAdDailyMetrics,
  metaLeadConversions,
  parseMarketingRange,
  rollupMarketingWeeks,
} from "./marketing.ts";

test("30-day default uses Adelaide today and includes exactly 30 dates", () => {
  const range = defaultMarketingRange(new Date("2026-07-21T23:00:00.000Z"));
  assert.deepEqual(range, { from: "2026-06-23", to: "2026-07-22" });
  assert.equal(marketingPresetFrom("2026-07-22", 7), "2026-07-16");
});

test("marketing ranges reject malformed, future, reversed and oversized dates", () => {
  const now = new Date("2026-07-22T02:00:00.000Z");
  assert.equal(parseMarketingRange("2026-02-30", "2026-07-22", now).ok, false);
  assert.equal(parseMarketingRange("2026-07-22", "2026-07-21", now).ok, false);
  assert.equal(parseMarketingRange("2026-07-01", "2026-07-23", now).ok, false);
  assert.equal(parseMarketingRange("2025-07-01", "2026-07-22", now).ok, false);
  assert.deepEqual(parseMarketingRange("2026-07-01", "2026-07-22", now), {
    ok: true,
    from: "2026-07-01",
    to: "2026-07-22",
  });
});

test("lead reporting explicitly excludes Potential Future Lead", () => {
  assert.equal(EXCLUDED_MARKETING_LEAD_STAGE, "Potential Future Lead");
});

test("Adelaide lead boundaries respect standard and daylight-saving offsets", () => {
  assert.deepEqual(adelaideUtcRange("2026-07-22", "2026-07-22"), {
    start: "2026-07-21T14:30:00.000Z",
    endExclusive: "2026-07-22T14:30:00.000Z",
  });
  assert.deepEqual(adelaideUtcRange("2026-01-10", "2026-01-10"), {
    start: "2026-01-09T13:30:00.000Z",
    endExclusive: "2026-01-10T13:30:00.000Z",
  });
});

test("Meta aggregate lead action is not double-counted with pixel lead", () => {
  assert.equal(
    metaLeadConversions([
      { action_type: "lead", value: "4" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "4" },
    ]),
    4
  );
  assert.equal(
    metaLeadConversions([{ action_type: "offsite_conversion.fb_pixel_lead", value: "3" }]),
    3
  );
});

test("daily platform data merges and rolls up Monday-to-Sunday", () => {
  const daily = mergeAdDailyMetrics(
    [
      { date: "2026-07-19", spend: 10, clicks: 0, impressions: 0, ctr: 0, conversions: 1 },
      { date: "2026-07-20", spend: 20, clicks: 0, impressions: 0, ctr: 0, conversions: 2 },
    ],
    [{ date: "2026-07-20", spend: 5, clicks: 0, impressions: 0, ctr: 0, conversions: 1 }]
  );
  assert.deepEqual(daily.map((row) => [row.date, row.total_spend]), [
    ["2026-07-19", 10],
    ["2026-07-20", 25],
  ]);
  assert.deepEqual(
    rollupMarketingWeeks(daily).map((row) => [row.week, row.total_spend, row.conversions]),
    [
      ["2026-07-13", 10, 1],
      ["2026-07-20", 25, 3],
    ]
  );
});
