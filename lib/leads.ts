// ============================================================
// RESLU Spec System — Leads pipeline shared math (Week 10)
// Shared, pure functions used by both the leads API routes
// (app/api/leads/**) and the UI (components/leads/**) so the
// needs-attention thresholds and dashboard totals can never drift
// between server and client. Deliberately dependency-free (no
// Supabase/Next imports) — every function here takes plain data in
// and returns plain data out.
//
// BUILD-SPEC.md "Week 10 — Leads pipeline": "Needs-attention panel:
// Proposal Sent >=4 days (nurture candidates) + Awaiting to Send
// Proposal >=7 days (stale proposals) + follow_up_date due/past" +
// "Pipeline dashboard: total pipeline value, per-stage totals/counts,
// avg days in stage."
// ============================================================

import {
  INACTIVE_LEAD_STAGES,
  LEAD_STAGES,
  type Lead,
  type LeadStage,
  type LeadStageEvent,
  type LeadStageSummary,
} from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days elapsed between an ISO timestamp and `now` (floor —
 * "4 days" means at least 4 full days have passed, not a fractional
 * day rounded up). */
export function daysSince(iso: string, now: Date = new Date()): number {
  const then = new Date(iso).getTime();
  return Math.floor((now.getTime() - then) / DAY_MS);
}

/** Whole days between `now` and a future ISO date/timestamp (positive
 * = still in the future). Used for the "next 7 days" site-visit
 * window and for follow-up due-ness. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const target = new Date(iso).getTime();
  return Math.ceil((target - now.getTime()) / DAY_MS);
}

/** True if a follow_up_date (date-only string) is today or in the
 * past — BUILD-SPEC "follow_up_date due/past", also drives the red
 * past-due card styling in the UI. */
export function isFollowUpDue(followUpDate: string | null, now: Date = new Date()): boolean {
  if (!followUpDate) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return new Date(followUpDate + "T00:00:00") <= today;
}

/** True if a follow_up_date is strictly in the past (used for the red
 * past-due card treatment specifically, as distinct from "due today"). */
export function isFollowUpPastDue(followUpDate: string | null, now: Date = new Date()): boolean {
  if (!followUpDate) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return new Date(followUpDate + "T00:00:00") < today;
}

/**
 * The timestamp a lead entered ITS CURRENT stage — the most recent
 * lead_stage_events row for this lead (`to_stage === lead.stage`), or
 * failing that (no stage-change history — e.g. a lead imported
 * straight into a non-default stage before any event trigger fired,
 * or freshly created) falls back to `received_at`, then `created_at`.
 * This is the anchor BUILD-SPEC's "Proposal Sent >=4 days" and
 * "Awaiting to Send Proposal >=7 days" thresholds measure from.
 */
export function enteredCurrentStageAt(lead: Lead, events: LeadStageEvent[]): string {
  const forThisLead = events
    .filter((e) => e.lead_id === lead.id && e.to_stage === lead.stage)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return forThisLead[0]?.at ?? lead.received_at ?? lead.created_at;
}

export interface AttentionGroups {
  nurture: Lead[];
  stale_proposals: Lead[];
  follow_ups_due: Lead[];
  site_visits_upcoming: Lead[];
}

/**
 * Computes the four needs-attention groups. `eventsByLead` should map
 * lead id -> that lead's lead_stage_events rows (only the rows needed
 * to resolve `enteredCurrentStageAt` — callers typically fetch all
 * events for the leads currently in 'Proposal Sent' /
 * 'Awaiting to Send Proposal' to keep the query cheap).
 *
 * A lead may legitimately appear in more than one group (e.g. a
 * 'Proposal Sent' lead whose follow_up_date is also overdue shows up
 * in both `nurture` and `follow_ups_due`) — BUILD-SPEC does not ask
 * these to be mutually exclusive, and the UI renders them as separate
 * sections, so duplication across groups is intentional, not a bug.
 */
export function computeAttentionGroups(
  leads: Lead[],
  eventsByLead: Map<string, LeadStageEvent[]>,
  now: Date = new Date()
): AttentionGroups {
  const nurture: Lead[] = [];
  const stale_proposals: Lead[] = [];
  const follow_ups_due: Lead[] = [];
  const site_visits_upcoming: Lead[] = [];

  for (const lead of leads) {
    if (lead.stage === "Proposal Sent") {
      const enteredAt = enteredCurrentStageAt(lead, eventsByLead.get(lead.id) ?? []);
      if (daysSince(enteredAt, now) >= 4) nurture.push(lead);
    }

    if (lead.stage === "Awaiting to Send Proposal") {
      const enteredAt = enteredCurrentStageAt(lead, eventsByLead.get(lead.id) ?? []);
      if (daysSince(enteredAt, now) >= 7) stale_proposals.push(lead);
    }

    if (isFollowUpDue(lead.follow_up_date, now)) {
      follow_ups_due.push(lead);
    }

    if (lead.site_visit_date) {
      const days = daysUntil(lead.site_visit_date, now);
      if (days >= 0 && days <= 7) site_visits_upcoming.push(lead);
    }
  }

  return { nurture, stale_proposals, follow_ups_due, site_visits_upcoming };
}

/** BUILD-SPEC "Pipeline dashboard: total pipeline value (sum
 * construction_value in active stages — exclude Lost/Complete/
 * Unable/Future)". */
export function isActiveStage(stage: LeadStage): boolean {
  return !INACTIVE_LEAD_STAGES.includes(stage);
}

export function totalPipelineValue(leads: Lead[]): number {
  return leads
    .filter((l) => isActiveStage(l.stage))
    .reduce((sum, l) => sum + (l.construction_value ?? 0), 0);
}

/**
 * Average days a lead spends in a given stage, from lead_stage_events
 * deltas — BUILD-SPEC "avg days in stage (from lead_stage_events
 * deltas, simple mean)". For each event where `to_stage === stage`,
 * the "time in stage" is measured to the NEXT event for that same lead
 * (i.e. the event that moved it OUT of `stage`); if there is no such
 * next event and the lead is CURRENTLY in that stage, time-in-stage
 * runs up to `now` (still accruing) — if the lead has since moved past
 * this stage with no recorded exit event (shouldn't happen given the
 * DB trigger fires on every stage UPDATE, but defensively: no next
 * event AND lead.stage !== stage), that occurrence is excluded rather
 * than guessed at. A simple (unweighted) mean of these per-visit
 * durations is returned, per "simple mean" in the spec — not
 * weighted by lead value or any other factor.
 */
export function avgDaysInStage(
  stage: LeadStage,
  leads: Lead[],
  allEvents: LeadStageEvent[],
  now: Date = new Date()
): number | null {
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const eventsByLead = new Map<string, LeadStageEvent[]>();
  for (const e of allEvents) {
    const arr = eventsByLead.get(e.lead_id) ?? [];
    arr.push(e);
    eventsByLead.set(e.lead_id, arr);
  }

  const durations: number[] = [];

  for (const [leadId, events] of eventsByLead) {
    const sorted = [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      if (ev.to_stage !== stage) continue;
      const next = sorted[i + 1];
      if (next) {
        durations.push((new Date(next.at).getTime() - new Date(ev.at).getTime()) / DAY_MS);
      } else {
        const lead = leadById.get(leadId);
        if (lead && lead.stage === stage) {
          durations.push((now.getTime() - new Date(ev.at).getTime()) / DAY_MS);
        }
        // else: no next event and lead has moved on — excluded, see
        // doc comment above.
      }
    }
  }

  if (durations.length === 0) return null;
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  return Math.round(mean * 10) / 10;
}

/** Builds the full per-stage dashboard summary (count + value + avg
 * days in stage) for every stage in pipeline order, plus the overall
 * total pipeline value. */
export function buildDashboardSummary(
  leads: Lead[],
  allEvents: LeadStageEvent[],
  now: Date = new Date()
): { total_pipeline_value: number; stages: LeadStageSummary[] } {
  const stages: LeadStageSummary[] = LEAD_STAGES.map((stage) => {
    const inStage = leads.filter((l) => l.stage === stage);
    return {
      stage,
      count: inStage.length,
      value: inStage.reduce((sum, l) => sum + (l.construction_value ?? 0), 0),
      avg_days_in_stage: avgDaysInStage(stage, leads, allEvents, now),
    };
  });

  return {
    total_pipeline_value: totalPipelineValue(leads),
    stages,
  };
}

/** Compact currency formatting for cards — BUILD-SPEC "construction_value
 * compact ('$650k')". Values >= $1,000,000 render as "$1.2m". */
export function formatCompactValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value)}`;
}

/** Lead age in whole days since received_at (falls back to
 * created_at) — BUILD-SPEC card field "lead age ('12 days')". */
export function leadAgeDays(lead: Lead, now: Date = new Date()): number {
  return daysSince(lead.received_at ?? lead.created_at, now);
}
