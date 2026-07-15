const AUTOMATION_PREFIX = "RESLU automation key:";

/** The currently-due future-nurture checkpoint. Only one checkpoint is
 * active at a time, so an existing 95-day lead gets one 90-day review,
 * not a noisy catch-up burst of 30 + 60 + 90. */
export function futureNurtureMilestone(daysInStage: number): 30 | 60 | 90 | null {
  if (daysInStage >= 90) return 90;
  if (daysInStage >= 60) return 60;
  if (daysInStage >= 30) return 30;
  return null;
}

export function automationMarker(key: string): string {
  return `${AUTOMATION_PREFIX} ${key}`;
}

export type AriaPriorityLane = "today" | "this_week" | "monitor";

/** Consistent Phase 5 ranking for Project Health evidence. */
export function projectHealthPriority(
  severity: "critical" | "warning" | "info",
  code: string
): AriaPriorityLane {
  if (severity === "critical") return "today";
  if (code === "trade_confirmation_due" || code === "ordering_due_soon") {
    return "this_week";
  }
  return "monitor";
}
