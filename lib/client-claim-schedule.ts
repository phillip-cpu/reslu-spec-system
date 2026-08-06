import type {
  ClientBillingProfile,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "../types/client-invoices";

const DAY_MS = 86_400_000;

export function addCalendarDays(date: string | null, days: number): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + Math.max(0, Math.trunc(days)));
  return parsed.toISOString().slice(0, 10);
}

export function resolveClaimForecastDate(input: {
  stage: ClientPaymentScheduleItem;
  profile: ClientBillingProfile | null;
  phases: ClientSchedulePhase[];
}): string | null {
  const { stage, profile, phases } = input;
  if (stage.trigger_type === "contract_signed") {
    return profile?.contract_signed_at ?? null;
  }
  if (stage.trigger_type === "schedule_phase") {
    return phases.find((phase) => phase.id === stage.schedule_phase_id)?.end_date ?? null;
  }
  return stage.milestone_date;
}

export type PlannedClaimTimingState = "needs_link" | "planned" | "review";

export function plannedClaimTimingState(
  forecastDate: string | null,
  today: string
): PlannedClaimTimingState {
  if (!forecastDate) return "needs_link";
  return forecastDate <= today ? "review" : "planned";
}

function comparableTokens(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/demolition/g, "demo")
    .replace(/practical completion/g, "practical")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized
    .split(/\s+/)
    .filter((token) => token && !["complete", "completion", "stage", "phase", "works"].includes(token));
}

/** Suggests an obvious program link for a newly-applied template. The user
 * still reviews and saves it; ties deliberately return null. */
export function suggestSchedulePhaseId(
  claimLabel: string,
  phases: ClientSchedulePhase[]
): string | null {
  const claimTokens = new Set(comparableTokens(claimLabel));
  if (claimTokens.size === 0) return null;
  const scored = phases
    .map((phase) => ({
      id: phase.id,
      score: comparableTokens(phase.name).filter((token) => claimTokens.has(token)).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].id;
}

export function dateDistanceDays(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      DAY_MS
  );
}
