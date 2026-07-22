import assert from "node:assert/strict";
import test from "node:test";
import {
  adelaideUtcRange,
  defaultMarketingRange,
  EXCLUDED_MARKETING_LEAD_STAGE,
  landingPageQuality,
  marketingPresetFrom,
  mergeAdDailyMetrics,
  mergeOrganicPagePerformance,
  metaLeadConversions,
  organicOpportunities,
  organicPageKind,
  parseMarketingRange,
  previousMarketingPeriod,
  resluPagePath,
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

test("organic pages split blog articles from core webpages", () => {
  assert.equal(resluPagePath("https://www.reslu.com.au/blog/design-build/"), "/blog/design-build");
  assert.equal(organicPageKind("/blog/design-build"), "blog");
  assert.equal(organicPageKind("/blog"), "page");
  assert.equal(organicPageKind("/services"), "page");
});

test("Search Console URL variants merge into one canonical page", () => {
  const performance = mergeOrganicPagePerformance(
    [
      { page: "https://reslu.com.au/", clicks: 2, impressions: 100, ctr: 0.02, position: 4 },
      { page: "https://www.reslu.com.au/", clicks: 3, impressions: 200, ctr: 0.015, position: 10 },
    ],
    [
      { page: "https://reslu.com.au/", clicks: 1, impressions: 50, ctr: 0.02, position: 3 },
      { page: "https://www.reslu.com.au/", clicks: 1, impressions: 50, ctr: 0.02, position: 5 },
    ]
  );
  assert.equal(performance.length, 1);
  assert.equal(performance[0]?.page, "/");
  assert.equal(performance[0]?.clicks, 5);
  assert.equal(performance[0]?.impressions, 300);
  assert.equal(performance[0]?.previous_clicks, 2);
  assert.equal(performance[0]?.position, 8);
});

test("organic comparison uses the immediately preceding equivalent range", () => {
  assert.deepEqual(previousMarketingPeriod("2026-07-16", "2026-07-22"), {
    from: "2026-07-09",
    to: "2026-07-15",
  });
});

test("organic opportunity engine ranks actionable CTR and ranking gaps", () => {
  const performance = mergeOrganicPagePerformance(
    [
      { page: "/services", clicks: 8, impressions: 1000, ctr: 0.008, position: 6 },
      { page: "/blog/design-build", clicks: 4, impressions: 500, ctr: 0.008, position: 13 },
    ],
    [
      { page: "/services", clicks: 9, impressions: 900, ctr: 0.01, position: 6.2 },
      { page: "/blog/design-build", clicks: 3, impressions: 400, ctr: 0.0075, position: 14 },
    ]
  );
  const insights = organicOpportunities(performance);
  assert.equal(insights.length, 2);
  assert.equal(insights[0]?.page, "/services");
  assert.equal(insights[0]?.title, "Turn impressions into clicks");
  assert.match(insights[0]?.action ?? "", /title and meta description/i);
  assert.equal(performance[1]?.kind, "blog");
  assert.ok(Math.abs((performance[1]?.clicks_change_pct ?? 0) - (100 / 3)) < 0.000001);
});

test("landing-page quality lists every non-blog page weakest first", () => {
  const performance = mergeOrganicPagePerformance(
    [
      { page: "/services", clicks: 5, impressions: 500, ctr: 0.01, position: 7 },
      { page: "/contact", clicks: 30, impressions: 200, ctr: 0.15, position: 2 },
      { page: "/blog/design-build", clicks: 20, impressions: 300, ctr: 0.067, position: 4 },
    ],
    [
      { page: "/services", clicks: 12, impressions: 450, ctr: 0.027, position: 4 },
      { page: "/contact", clicks: 25, impressions: 180, ctr: 0.139, position: 2.5 },
    ]
  );
  const quality = landingPageQuality(performance);
  assert.equal(quality.length, 2);
  assert.equal(quality[0]?.page, "/services");
  assert.equal(quality[0]?.primary_signal, "Visibility is slipping");
  assert.equal(quality[0]?.confidence, "High");
  assert.equal(quality[1]?.page, "/contact");
  assert.equal(quality[1]?.quality_label, "Strong");
});

test("organic opportunity engine groups simultaneous core-page declines", () => {
  const performance = mergeOrganicPagePerformance(
    [
      { page: "/", clicks: 1, impressions: 500, ctr: 0.002, position: 15 },
      { page: "/services", clicks: 2, impressions: 400, ctr: 0.005, position: 13 },
      { page: "/contact", clicks: 1, impressions: 250, ctr: 0.004, position: 11 },
      { page: "/blog/design-build", clicks: 1, impressions: 150, ctr: 0.0067, position: 18 },
    ],
    [
      { page: "/", clicks: 8, impressions: 600, ctr: 0.013, position: 8 },
      { page: "/services", clicks: 7, impressions: 450, ctr: 0.015, position: 9 },
      { page: "/contact", clicks: 5, impressions: 280, ctr: 0.018, position: 8 },
      { page: "/blog/design-build", clicks: 5, impressions: 170, ctr: 0.029, position: 12 },
    ]
  );
  const insights = organicOpportunities(performance);
  const sitewide = insights.find((insight) => insight.title === "Investigate a site-wide organic decline");
  assert.deepEqual(sitewide?.affected_pages.sort(), ["/", "/contact", "/services"]);
  assert.equal(insights.filter((insight) => insight.title === "Recover slipping visibility").length, 1);
});

test("small percentage swings do not become decline emergencies", () => {
  const performance = mergeOrganicPagePerformance(
    [{ page: "/contact", clicks: 1, impressions: 30, ctr: 0.033, position: 8 }],
    [{ page: "/contact", clicks: 3, impressions: 35, ctr: 0.086, position: 8.5 }]
  );
  const insight = organicOpportunities(performance)[0];
  assert.notEqual(insight?.title, "Recover slipping visibility");
});
