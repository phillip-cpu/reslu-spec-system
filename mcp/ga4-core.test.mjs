import test from "node:test";
import assert from "node:assert/strict";
import { buildFunnelRequests, buildGenericRequest, buildLandingRequest, normalizeDate, normalizeDays, normalizeLimit, PROPERTY, summarizeFunnel } from "./ga4-core.mjs";

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
  assert.equal(landing.dimensionFilter.andGroup.expressions[0].filter.stringFilter.value, "Paid Search");
  const funnel = buildFunnelRequests({ days: 30 });
  assert.equal(funnel.events.dateRanges[0].endDate, "yesterday");
  assert.ok(funnel.pages.dimensionFilter.andGroup.expressions[0].filter.inListFilter.values.includes("/begin/renovation"));
  assert.equal(JSON.stringify(funnel).includes("REFRESH_TOKEN"), false);
});

test('current events, rooms, engagement and explicit dates are available with matching cohorts', () => {
  const args = {start_date:'2026-09-10', end_date:'today', campaign_id:'24227641382', channel:'Paid Search'};
  const funnel = buildFunnelRequests(args);
  const eventFilters = funnel.events.dimensionFilter.andGroup.expressions;
  const pageFilters = funnel.pages.dimensionFilter.andGroup.expressions;
  assert.ok(eventFilters[0].filter.inListFilter.values.includes('reslu_form_view'));
  assert.ok(eventFilters[0].filter.inListFilter.values.includes('reslu_form_start'));
  assert.ok(eventFilters[0].filter.inListFilter.values.includes('reslu_form_current_step'));
  assert.ok(pageFilters[0].filter.inListFilter.values.includes('/begin/rooms'));
  assert.deepEqual(eventFilters.slice(1), pageFilters.slice(1));
  assert.deepEqual(funnel.events.dateRanges, [{startDate:'2026-09-10', endDate:'today'}]);
  assert.equal(funnel.days, null, 'explicit ranges do not claim an unused 30-day window');
  const landing = buildLandingRequest(args);
  assert.ok(landing.metrics.some(m => m.name === 'userEngagementDuration'));
  assert.ok(landing.metrics.some(m => m.name === 'averageSessionDuration'));
  assert.deepEqual(landing.dimensionFilter.andGroup.expressions, eventFilters.slice(1));
});

test('QA exclusion is explicit and can be disabled for controlled diagnostics', () => {
  const request = buildFunnelRequests({exclude_internal_qa:false});
  assert.ok(request.events.dimensionFilter.filter);
  assert.equal(JSON.stringify(request).includes('notExpression'), false);
});

test('missing and legacy-only events cannot be represented as a valid zero funnel', () => {
  for (const rows of [[], [{dimensions:['form_step_1'], metrics:['5','2']}]]) {
    const result = summarizeFunnel(buildFunnelRequests(), {rows, interpretation_limits:[]}, {rows:[]});
    assert.equal(result.observed_current_form_events, false);
    assert.equal(result.sequence_is_monotonic, null);
    assert.equal(result.current_form_event_counts.reslu_form_start, null);
    assert.match(result.interpretation, /insufficient measurement evidence/);
  }
});
