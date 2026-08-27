const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type MarketingStrategyPhase =
  | "scheduled"
  | "preparing"
  | "observing"
  | "review_due";

export interface MarketingStrategyCheckpoint {
  id: string;
  label: string;
  at: string;
}

export interface MarketingStrategy {
  id: string;
  channel: string;
  owner: string;
  title: string;
  summary: string;
  activatedAt: string;
  observationStartsAt: string;
  reportingDayEndsAt: readonly string[];
  reviewAt: string;
  holdInstruction: string;
  liveSetup: readonly string[];
  checkpoints: readonly MarketingStrategyCheckpoint[];
}

export interface MarketingStrategySnapshot {
  phase: MarketingStrategyPhase;
  completeDays: number;
  reportingDays: number;
  reportingDaysRemaining: number;
  progressPercent: number;
  reviewDue: boolean;
  remainingMs: number;
  nextCheckpoint: MarketingStrategyCheckpoint | null;
}

/**
 * Current approved marketing experiments and recovery windows.
 *
 * Reporting-day end times are explicit so a "complete day" always follows
 * the Adelaide business calendar rather than a rolling 24-hour calculation.
 */
export const CURRENT_MARKETING_STRATEGIES: readonly MarketingStrategy[] = [
  {
    id: "google-ads-recovery-2026-08-27",
    channel: "Google Ads",
    owner: "Marco",
    title: "Seven-day Google Ads recovery",
    summary:
      "Stabilise Home Renovation traffic and collect a clean baseline before approving the next campaign change.",
    activatedAt: "2026-08-27T09:55:00+09:30",
    observationStartsAt: "2026-08-28T00:00:00+09:30",
    reportingDayEndsAt: [
      "2026-08-29T00:00:00+09:30",
      "2026-08-30T00:00:00+09:30",
      "2026-08-31T00:00:00+09:30",
      "2026-09-01T00:00:00+09:30",
      "2026-09-02T00:00:00+09:30",
      "2026-09-03T00:00:00+09:30",
      "2026-09-04T00:00:00+09:30",
    ],
    reviewAt: "2026-09-04T06:15:00+09:30",
    holdInstruction:
      "Keep bids, budgets, keywords and tracking unchanged until the Day 7 review. Intervene early only for a documented safety or waste stop.",
    liveSetup: [
      "Home enabled · $60/day · $20 maximum CPC",
      "Kitchen paused · no budget reallocation",
      "Presence-only targeting · 18 postcodes",
      "Exact and phrase keywords · no broad match",
      "Seven-day spend ceiling · $420",
    ],
    checkpoints: [
      {
        id: "early-safety-check",
        label: "Early safety check",
        at: "2026-08-28T06:15:00+09:30",
      },
      {
        id: "three-day-gate",
        label: "Three-day volume gate",
        at: "2026-08-31T06:15:00+09:30",
      },
      {
        id: "seven-day-decision",
        label: "Seven-day decision",
        at: "2026-09-04T06:15:00+09:30",
      },
    ],
  },
];

function instant(value: string): number {
  return new Date(value).getTime();
}

export function marketingStrategySnapshot(
  strategy: MarketingStrategy,
  now: Date = new Date()
): MarketingStrategySnapshot {
  const nowMs = now.getTime();
  const activatedAtMs = instant(strategy.activatedAt);
  const observationStartsAtMs = instant(strategy.observationStartsAt);
  const reviewAtMs = instant(strategy.reviewAt);
  const completeDays = strategy.reportingDayEndsAt.filter(
    (dayEndsAt) => instant(dayEndsAt) <= nowMs
  ).length;
  const reportingDays = strategy.reportingDayEndsAt.length;
  const reviewDue = nowMs >= reviewAtMs;

  let phase: MarketingStrategyPhase;
  if (nowMs < activatedAtMs) phase = "scheduled";
  else if (nowMs < observationStartsAtMs) phase = "preparing";
  else if (reviewDue) phase = "review_due";
  else phase = "observing";

  return {
    phase,
    completeDays,
    reportingDays,
    reportingDaysRemaining: Math.max(0, reportingDays - completeDays),
    progressPercent:
      reportingDays === 0 ? 100 : Math.round((completeDays / reportingDays) * 100),
    reviewDue,
    remainingMs: Math.max(0, reviewAtMs - nowMs),
    nextCheckpoint:
      strategy.checkpoints.find((checkpoint) => instant(checkpoint.at) > nowMs) ?? null,
  };
}

/** Compact, conservative countdown for a quick operational snapshot. */
export function compactRemainingDuration(remainingMs: number): string {
  if (remainingMs <= 0) return "Ready now";

  const totalMinutes = Math.ceil(remainingMs / MINUTE_MS);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const days = Math.floor(totalMinutes / (DAY_MS / MINUTE_MS));
  const hours = Math.floor((totalMinutes % (DAY_MS / MINUTE_MS)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
