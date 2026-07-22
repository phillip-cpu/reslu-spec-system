const ADELAIDE_TIME_ZONE = "Australia/Adelaide";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_MARKETING_RANGE_DAYS = 366;
export const EXCLUDED_MARKETING_LEAD_STAGE = "Potential Future Lead";

export type MarketingSourceState = "connected" | "not_configured" | "error";

export interface MarketingSourceStatus {
  state: MarketingSourceState;
  message?: string;
}

export interface AdDailyMetric {
  date: string;
  spend: number;
  clicks: number;
  impressions: number;
  ctr: number;
  conversions: number;
}

export interface CombinedDailyMetric {
  date: string;
  google_spend: number;
  meta_spend: number;
  total_spend: number;
  conversions: number;
}

export interface WeeklyMarketingMetric {
  week: string;
  total_spend: number;
  google_spend: number;
  meta_spend: number;
  conversions: number;
}

export type OrganicPageKind = "blog" | "page";

export interface OrganicPageMetric {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface OrganicPagePerformance extends OrganicPageMetric {
  kind: OrganicPageKind;
  previous_clicks: number;
  previous_impressions: number;
  previous_position: number | null;
  clicks_change_pct: number | null;
  impressions_change_pct: number | null;
  position_change: number | null;
}

export interface OrganicOpportunity {
  page: string;
  kind: OrganicPageKind;
  score: number;
  priority: "high" | "medium" | "watch";
  title: string;
  action: string;
  reason: string;
  predicted_impact: string;
}

export type MarketingRangeResult =
  | { ok: true; from: string; to: string }
  | { ok: false; error: string };

/** RESLU reporting dates always follow the Adelaide business calendar. */
export function adelaideDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ADELAIDE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addIsoDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** A 7-day preset includes today plus the six preceding calendar days. */
export function marketingPresetFrom(to: string, days: number): string {
  return addIsoDays(to, -(Math.max(1, Math.trunc(days)) - 1));
}

/** The comparison period immediately precedes the selected inclusive range. */
export function previousMarketingPeriod(from: string, to: string): { from: string; to: string } {
  const rangeDays = Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000
  ) + 1;
  const previousTo = addIsoDays(from, -1);
  return {
    from: addIsoDays(previousTo, -(rangeDays - 1)),
    to: previousTo,
  };
}

export function defaultMarketingRange(now: Date = new Date()): { from: string; to: string } {
  const to = adelaideDate(now);
  return { from: marketingPresetFrom(to, 30), to };
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseMarketingRange(
  fromInput: string | null,
  toInput: string | null,
  now: Date = new Date()
): MarketingRangeResult {
  const defaults = defaultMarketingRange(now);
  const from = fromInput || defaults.from;
  const to = toInput || defaults.to;

  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return { ok: false, error: "Dates must use YYYY-MM-DD." };
  }
  if (from > to) {
    return { ok: false, error: "From date must be on or before the to date." };
  }
  if (to > defaults.to) {
    return { ok: false, error: "The reporting range cannot extend into the future." };
  }

  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (days > MAX_MARKETING_RANGE_DAYS) {
    return {
      ok: false,
      error: `Choose a range of ${MAX_MARKETING_RANGE_DAYS} days or less.`,
    };
  }

  return { ok: true, from, to };
}

function timeZoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: ADELAIDE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return localAsUtc - instant.getTime();
}

/** Convert an Adelaide calendar midnight into the exact UTC instant. */
function adelaideMidnightUtc(date: string): string {
  const wallClockUtc = Date.parse(`${date}T00:00:00.000Z`);
  let estimate = new Date(wallClockUtc);
  // Two passes handle the offset changing between the UTC seed and the
  // requested Adelaide wall time at a daylight-saving boundary.
  for (let pass = 0; pass < 2; pass += 1) {
    estimate = new Date(wallClockUtc - timeZoneOffsetMs(estimate));
  }
  return estimate.toISOString();
}

/** Inclusive Adelaide dates expressed as [UTC start, UTC end-exclusive). */
export function adelaideUtcRange(from: string, to: string): { start: string; endExclusive: string } {
  return {
    start: adelaideMidnightUtc(from),
    endExclusive: adelaideMidnightUtc(addIsoDays(to, 1)),
  };
}

export function mergeAdDailyMetrics(
  google: AdDailyMetric[] = [],
  meta: AdDailyMetric[] = []
): CombinedDailyMetric[] {
  const googleByDate = new Map(google.map((row) => [row.date, row]));
  const metaByDate = new Map(meta.map((row) => [row.date, row]));
  const dates = new Set([...googleByDate.keys(), ...metaByDate.keys()]);

  return [...dates]
    .sort()
    .map((date) => {
      const googleRow = googleByDate.get(date);
      const metaRow = metaByDate.get(date);
      const googleSpend = googleRow?.spend ?? 0;
      const metaSpend = metaRow?.spend ?? 0;
      return {
        date,
        google_spend: googleSpend,
        meta_spend: metaSpend,
        total_spend: googleSpend + metaSpend,
        conversions: (googleRow?.conversions ?? 0) + (metaRow?.conversions ?? 0),
      };
    });
}

export function rollupMarketingWeeks(daily: CombinedDailyMetric[]): WeeklyMarketingMetric[] {
  const weeks = new Map<string, WeeklyMarketingMetric>();
  for (const row of daily) {
    const date = new Date(`${row.date}T00:00:00.000Z`);
    const dayOfWeek = date.getUTCDay();
    const offsetFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const week = addIsoDays(row.date, -offsetFromMonday);
    const current = weeks.get(week) ?? {
      week,
      total_spend: 0,
      google_spend: 0,
      meta_spend: 0,
      conversions: 0,
    };
    current.total_spend += row.total_spend;
    current.google_spend += row.google_spend;
    current.meta_spend += row.meta_spend;
    current.conversions += row.conversions;
    weeks.set(week, current);
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

interface MetaAction {
  action_type?: unknown;
  value?: unknown;
}

/**
 * Meta often returns both the aggregate `lead` action and its underlying
 * pixel lead action. Prefer the aggregate and fall back to a specific lead
 * action so the same conversion is never added twice.
 */
export function metaLeadConversions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  const rows = actions.filter((row): row is MetaAction => !!row && typeof row === "object");
  const priority = [
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
  ];
  for (const actionType of priority) {
    const matches = rows.filter((row) => row.action_type === actionType);
    if (matches.length > 0) {
      return matches.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
    }
  }
  return 0;
}

export function resluPagePath(value: string): string {
  try {
    const url = new URL(value, "https://www.reslu.com.au");
    const path = url.pathname.replace(/\/{2,}/g, "/");
    return path === "/" ? "/" : path.replace(/\/$/, "");
  } catch {
    const path = value.split(/[?#]/, 1)[0]?.trim() || "/";
    return path.startsWith("/") ? path : `/${path}`;
  }
}

export function organicPageKind(page: string): OrganicPageKind {
  return /^\/blog\/.+/.test(resluPagePath(page)) ? "blog" : "page";
}

function percentageChange(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

export function mergeOrganicPagePerformance(
  current: OrganicPageMetric[],
  previous: OrganicPageMetric[]
): OrganicPagePerformance[] {
  const previousByPage = new Map(previous.map((row) => [resluPagePath(row.page), row]));
  return current
    .map((row) => {
      const page = resluPagePath(row.page);
      const prior = previousByPage.get(page);
      return {
        ...row,
        page,
        kind: organicPageKind(page),
        previous_clicks: prior?.clicks ?? 0,
        previous_impressions: prior?.impressions ?? 0,
        previous_position: prior?.position ?? null,
        clicks_change_pct: percentageChange(row.clicks, prior?.clicks ?? 0),
        impressions_change_pct: percentageChange(row.impressions, prior?.impressions ?? 0),
        position_change: prior ? prior.position - row.position : null,
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

function expectedOrganicCtr(position: number): number {
  if (position <= 3) return 0.12;
  if (position <= 5) return 0.07;
  if (position <= 10) return 0.035;
  if (position <= 20) return 0.015;
  return 0.008;
}

/**
 * Directional organic opportunity scoring. It combines current demand
 * (impressions), ranking proximity, CTR headroom and prior-period movement.
 * It recommends the next action but deliberately avoids guaranteed forecasts.
 */
export function organicOpportunities(
  pages: OrganicPagePerformance[],
  limit = 6
): OrganicOpportunity[] {
  return pages
    .filter((page) => page.impressions >= 10)
    .map((page): OrganicOpportunity => {
      const expectedCtr = expectedOrganicCtr(page.position);
      const ctrGap = Math.max(0, expectedCtr - page.ctr);
      const demandScore = Math.min(35, Math.log10(page.impressions + 1) * 13);
      const proximityScore = page.position <= 3
        ? 8
        : page.position <= 10
          ? 24
          : page.position <= 20
            ? 30
            : page.position <= 40
              ? 18
              : 6;
      const ctrScore = expectedCtr > 0 ? Math.min(20, (ctrGap / expectedCtr) * 20) : 0;
      const declineScore = (page.clicks_change_pct ?? 0) <= -30 || (page.position_change ?? 0) <= -2
        ? 18
        : 0;
      const score = Math.round(Math.min(100, demandScore + proximityScore + ctrScore + declineScore));

      let title: string;
      let action: string;
      let reason: string;
      let predictedImpact: string;

      if (declineScore > 0 && page.previous_clicks > 0) {
        title = "Recover slipping visibility";
        action = "Refresh the page, confirm its search intent, update examples and strengthen links from relevant RESLU pages.";
        reason = `Clicks are ${Math.abs(Math.round(page.clicks_change_pct ?? 0))}% lower than the preceding period${(page.position_change ?? 0) < 0 ? ` and average position slipped ${Math.abs(page.position_change ?? 0).toFixed(1)} places` : ""}.`;
        predictedImpact = "Likely opportunity: recover lost clicks and stabilise ranking.";
      } else if (page.position <= 10 && ctrGap > expectedCtr * 0.35) {
        title = "Turn impressions into clicks";
        action = "Rewrite the page title and meta description around the searcher's decision, while keeping the page content aligned.";
        reason = `${page.impressions.toLocaleString()} impressions at position ${page.position.toFixed(1)}, but CTR is ${(page.ctr * 100).toFixed(1)}%.`;
        predictedImpact = "Likely opportunity: gain more clicks without needing a ranking increase.";
      } else if (page.position > 7 && page.position <= 20) {
        title = "Push towards page one";
        action = "Expand the most useful answer, add project evidence and link to this page from closely related services and articles.";
        reason = `${page.impressions.toLocaleString()} impressions with an average position of ${page.position.toFixed(1)} places it within striking distance.`;
        predictedImpact = "Likely opportunity: improve first-page visibility for relevant searches.";
      } else if (page.position > 20 && page.position <= 50) {
        title = "Build topical authority";
        action = page.kind === "blog"
          ? "Deepen the article and connect it to a relevant service page with clear internal links."
          : "Create a focused supporting article, then link it back to this service page.";
        reason = `Search demand exists (${page.impressions.toLocaleString()} impressions), but average position is ${page.position.toFixed(1)}.`;
        predictedImpact = "Likely opportunity: grow qualified impressions and improve topical relevance.";
      } else {
        title = "Extend a current winner";
        action = "Protect the page's core intent, add a useful supporting section and target one closely related search question.";
        reason = `${page.clicks.toLocaleString()} clicks from ${page.impressions.toLocaleString()} impressions at position ${page.position.toFixed(1)}.`;
        predictedImpact = "Likely opportunity: defend current visibility and capture adjacent searches.";
      }

      return {
        page: page.page,
        kind: page.kind,
        score,
        priority: score >= 70 ? "high" : score >= 50 ? "medium" : "watch",
        title,
        action,
        reason,
        predicted_impact: predictedImpact,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}
