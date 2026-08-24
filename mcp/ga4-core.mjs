import fs from "node:fs";

export const ENV_PATH = "/Users/vale/.openclaw/workspace/google-ads/.env";
export const PROPERTY = "properties/375473067";
const MAX_LIMIT = 250;

export function loadKeyValues(filePath = ENV_PATH) {
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function normalizeDays(value) {
  const days = Number.parseInt(String(value ?? "30"), 10);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("days must be an integer from 1 to 366");
  }
  return days;
}

export function normalizeLimit(value) {
  const limit = Number.parseInt(String(value ?? "50"), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

export function normalizeDate(value, name) {
  const date = String(value ?? "").trim();
  if (!/^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,3}daysAgo)$/.test(date)) {
    throw new Error(`${name} must be YYYY-MM-DD, today, yesterday, or NdaysAgo`);
  }
  return date;
}

function normalizeNames(values, kind, max) {
  if (!Array.isArray(values) || values.length < 1 || values.length > max) {
    throw new Error(`${kind} must contain 1-${max} names`);
  }
  return values.map((item) => {
    const name = String(item ?? "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid ${kind} name: ${name}`);
    return { name };
  });
}

export function buildGenericRequest(args = {}) {
  const startDate = normalizeDate(args.start_date, "start_date");
  const endDate = normalizeDate(args.end_date, "end_date");
  const request = {
    dateRanges: [{ startDate, endDate }],
    dimensions: normalizeNames(args.dimensions, "dimensions", 9),
    metrics: normalizeNames(args.metrics, "metrics", 10),
    limit: normalizeLimit(args.limit),
    keepEmptyRows: Boolean(args.keep_empty_rows),
  };
  if (args.dimension_filter !== undefined) {
    if (!args.dimension_filter || typeof args.dimension_filter !== "object" || Array.isArray(args.dimension_filter)) {
      throw new Error("dimension_filter must be a GA4 FilterExpression object");
    }
    request.dimensionFilter = args.dimension_filter;
  }
  if (args.metric_filter !== undefined) {
    if (!args.metric_filter || typeof args.metric_filter !== "object" || Array.isArray(args.metric_filter)) {
      throw new Error("metric_filter must be a GA4 FilterExpression object");
    }
    request.metricFilter = args.metric_filter;
  }
  if (Array.isArray(args.order_bys) && args.order_bys.length) request.orderBys = args.order_bys.slice(0, 5);
  return request;
}

export function buildLandingRequest(args = {}) {
  const startDate = normalizeDate(args.start_date, "start_date");
  const endDate = normalizeDate(args.end_date, "end_date");
  const channel = String(args.channel ?? "").trim();
  const request = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: "landingPagePlusQueryString" },
      { name: "sessionDefaultChannelGroup" },
    ],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "engagedSessions" },
      { name: "screenPageViews" },
      { name: "bounceRate" },
      { name: "keyEvents" },
    ],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: normalizeLimit(args.limit),
  };
  if (channel) {
    request.dimensionFilter = {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "EXACT", value: channel, caseSensitive: false },
      },
    };
  }
  return request;
}

export function buildFunnelRequests(args = {}) {
  const days = normalizeDays(args.days);
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "yesterday" }];
  const eventNames = [
    "form_step_1", "form_step_2", "form_step_3", "form_step_4",
    "generate_lead", "brief_autofilled", "begin_confirmation_view",
    "form_delivery_error", "form_validation_error", "form_photo_added",
  ];
  return {
    days,
    events: {
      dateRanges,
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: eventNames } } },
      limit: 50,
    },
    pages: {
      dateRanges,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
      dimensionFilter: {
        filter: {
          fieldName: "pagePath",
          inListFilter: { values: ["/begin/renovation", "/begin/kitchen", "/begin/bathroom", "/begin", "/begin/design-build", "/begin/extensions", "/landing-renovations-bathroom"] },
        },
      },
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 50,
    },
  };
}

async function accessToken() {
  const env = loadKeyValues();
  const clientId = env.GOOGLE_ANALYTICS_CLIENT_ID;
  const clientSecret = env.GOOGLE_ANALYTICS_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_ANALYTICS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("GA4 OAuth credentials are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`GA4 token request failed: ${body.error || response.status}`);
  return body.access_token;
}

export async function runReport(request) {
  const token = await accessToken();
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/${PROPERTY}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || `GA4 Data API HTTP ${response.status}`);
  return {
    property: PROPERTY,
    generated_at: new Date().toISOString(),
    dimension_headers: (body.dimensionHeaders || []).map((item) => item.name),
    metric_headers: (body.metricHeaders || []).map((item) => item.name),
    rows: (body.rows || []).map((row) => ({
      dimensions: (row.dimensionValues || []).map((item) => item.value),
      metrics: (row.metricValues || []).map((item) => item.value),
    })),
    row_count: body.rowCount || 0,
    metadata: body.metadata || null,
    interpretation_limits: [
      "GA4 events are instrumentation evidence, not RESLU valid or qualified leads.",
      "Current-day data may be incomplete; standard reports end yesterday unless explicitly requested.",
      "Keep platform, analytics, and RESLU populations separate without record-level linkage.",
    ],
  };
}

export async function readFunnel(args = {}) {
  const requests = buildFunnelRequests(args);
  const [events, pages] = await Promise.all([runReport(requests.events), runReport(requests.pages)]);
  const eventCounts = Object.fromEntries(events.rows.map((row) => [row.dimensions[0], Number(row.metrics[0] || 0)]));
  const sequence = ["form_step_1", "form_step_2", "form_step_3", "form_step_4", "generate_lead"];
  const counts = sequence.map((name) => eventCounts[name] || 0);
  const monotonic = counts.every((value, index) => index === 0 || value <= counts[index - 1]);
  return {
    schema_version: "reslu-ga4-funnel-v2",
    property: PROPERTY,
    days: requests.days,
    event_counts: eventCounts,
    landing_page_rows: pages.rows,
    sequence_is_monotonic: monotonic,
    interpretation: monotonic
      ? "Event counts are ordered, but event-level ratios still require user/session and implementation checks."
      : "Event ordering is impossible for a simple funnel. Diagnose instrumentation before using step conversion rates.",
    interpretation_limits: events.interpretation_limits,
  };
}
