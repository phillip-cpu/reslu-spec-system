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
