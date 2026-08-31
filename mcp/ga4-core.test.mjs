import test from "node:test";
import assert from "node:assert/strict";
import { buildFunnelRequests, buildGenericRequest, buildLandingRequest, normalizeDate, normalizeDays, normalizeLimit, PROPERTY } from "./ga4-core.mjs";

test("connector is fixed to the RESLU property", () => {
  assert.equal(PROPERTY, "properties/375473067");
});

test("bounds days and limits", () => {
  assert.equal(normalizeDays(30), 30);
  assert.equal(normalizeLimit(250), 250);
  assert.throws(() => normalizeDays(0));
  assert.throws(() => normalizeLimit(251));
});

test("accepts GA4 relative and ISO dates", () => {
  assert.equal(normalizeDate("30daysAgo", "start"), "30daysAgo");
  assert.equal(normalizeDate("2026-08-20", "end"), "2026-08-20");
  assert.throws(() => normalizeDate("last month", "start"));
});

test("builds a bounded generic report", () => {
  const request = buildGenericRequest({
    start_date: "30daysAgo",
    end_date: "yesterday",
    dimensions: ["sessionDefaultChannelGroup"],
    metrics: ["sessions"],
    limit: 25,
  });
  assert.equal(request.limit, 25);
  assert.deepEqual(request.dimensions, [{ name: "sessionDefaultChannelGroup" }]);
  assert.deepEqual(request.metrics, [{ name: "sessions" }]);
});

test("builds landing and funnel reports without credentials", () => {
  const landing = buildLandingRequest({ start_date: "30daysAgo", end_date: "yesterday", channel: "Paid Search" });
  assert.equal(landing.dimensionFilter.filter.stringFilter.value, "Paid Search");
  const funnel = buildFunnelRequests({ days: 30 });
  assert.equal(funnel.events.dateRanges[0].endDate, "yesterday");
  assert.ok(funnel.pages.dimensionFilter.filter.inListFilter.values.includes("/begin/renovation"));
  assert.equal(JSON.stringify(funnel).includes("REFRESH_TOKEN"), false);
});
