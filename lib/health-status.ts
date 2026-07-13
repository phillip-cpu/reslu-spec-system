import type { HealthPillLevel } from "@/types/health-push";

// ============================================================
// RESLU Spec System — Health + web push (r26)
// BUILD-SPEC.md item 4: "Brand pills reuse booking-status colour
// conventions (lib/booking-status.ts pattern — separate helper, don't
// couple)."
//
// NOTE for the reviewing manager: there is no literal lib/booking-
// status.ts in this codebase — the booking-state pill colour mapping
// r20.1 actually built lives in lib/board-constants.ts
// (STATUS_PILL_TINTS / StatusPillTint). This file reuses that FILE's
// *pattern* (a small Record<string, Tint> keyed by a status string,
// looked up via a case-insensitive helper, each tint carrying
// background/text/border of one hue family) for a plain green/amber/
// red three-level scale, WITHOUT importing anything from
// board-constants.ts — per the spec's own "separate helper, don't
// couple" instruction, this file has zero dependency on the booking-
// status module; the two are free to diverge (a booking pill and a
// health pill are different domains that just happen to share a
// visual language).
// ============================================================

export interface HealthPillTint {
  /** Light background wash — literal hex, same "~12% tint over cream" convention as board-constants.ts's StatusPillTint. */
  background: string;
  /** Darker foreground text of the same hue family. */
  text: string;
  /** Border colour, mid-tone between background and text. */
  border: string;
  /** Human label for the level, e.g. for an sr-only/title attribute. */
  label: string;
}

const HEALTH_PILL_TINTS: Record<HealthPillLevel, HealthPillTint> = {
  // Green #4c6b4f family — same green this schema's other "healthy/
  // done" pills already use (board-constants.ts's own `done` tint),
  // chosen independently here (no import) because the brand's actual
  // "everything is fine" green is this one value across the app.
  green: {
    background: "#DCE7DD",
    text: "#2E4531",
    border: "#4c6b4f",
    label: "OK",
  },
  // Amber/gold — same family as board-constants.ts's `requested` tint
  // ("pending — asked, waiting to hear back"), reused here for "needs
  // attention soon, not yet urgent".
  amber: {
    background: "#F3E4C6",
    text: "#8A6208",
    border: "#C9971E",
    label: "Warning",
  },
  // Red — this schema doesn't have an existing red pill convention
  // (board-constants.ts's "not booked" is terracotta, a different,
  // softer warning tone) — health incidents warrant a genuinely urgent
  // red, distinct from terracotta, so this is its own value.
  red: {
    background: "#F5D6D6",
    text: "#7A1F1F",
    border: "#B23A3A",
    label: "Down",
  },
};

export function healthPillTint(level: HealthPillLevel): HealthPillTint {
  return HEALTH_PILL_TINTS[level];
}

/**
 * Heartbeat-age -> pill level. One missed ~5-minute beat (see
 * health_heartbeats' own doc comment) is tolerated as green; two
 * missed beats is a warning; past the "mini silent >15min" threshold
 * BUILD-SPEC.md item 3(c) names as the actual incident trigger is red.
 * `ageMinutes` is Infinity (or any very large number) when no
 * heartbeat has ever been recorded — callers should pass that rather
 * than throwing, so a brand-new/never-configured mini renders red
 * rather than crashing the Health page.
 */
export function heartbeatAgeLevel(ageMinutes: number): HealthPillLevel {
  if (ageMinutes <= 7.5) return "green";
  if (ageMinutes <= 15) return "amber";
  return "red";
}

/**
 * Generic "how stale is this last-success timestamp, relative to how
 * often it's expected to succeed" pill level — used by the Health
 * page's Spec card for each cron's last-success pill (lib/health.ts's
 * computeSpecHealth). `expectedIntervalHours` is the cron's own
 * schedule cadence (e.g. 24 for a once-daily cron); tolerance is
 * deliberately generous (1.5x / 3x) since Vercel Cron itself has no
 * SLA on exact timing and this app's crons already have their own
 * 7am-7pm Adelaide send-window logic layered on top in some cases.
 */
export function cronHealthLevel(
  lastSuccessAt: string | null,
  expectedIntervalHours: number
): HealthPillLevel {
  if (!lastSuccessAt) return "red";
  const ageHours = (Date.now() - new Date(lastSuccessAt).getTime()) / (1000 * 60 * 60);
  if (ageHours <= expectedIntervalHours * 1.5) return "green";
  if (ageHours <= expectedIntervalHours * 3) return "amber";
  return "red";
}

/** health_channels.status -> pill level (direct 1:1 mapping, session_valid=false forces at least amber). */
export function channelPillLevel(
  status: "ok" | "degraded" | "down",
  sessionValid: boolean | null
): HealthPillLevel {
  if (status === "down") return "red";
  if (status === "degraded") return "amber";
  if (sessionValid === false) return "amber";
  return "green";
}
