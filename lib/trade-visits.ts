// ============================================================
// RESLU Spec System — Trade visits & Timeline v2 shared domain logic
// (Phase 11A). Pure, dependency-free helpers — no Supabase/Next
// imports, plain data in/out — mirroring lib/leads.ts's shape so the
// needs-attention thresholds and date math can never drift between
// server and client.
//
// Why this file duplicates small date helpers (daysUntil-style math)
// instead of importing them from lib/leads.ts: leads and trade visits
// are unrelated domains that happen to both do day-count arithmetic —
// coupling this file to lib/leads.ts would mean any future change to
// leads' date semantics (e.g. a different "day" definition, business
// days, etc.) could silently ripple into trade-visit scheduling, or
// vice versa. Keeping this module fully self-contained, like lib/gantt.ts,
// is a deliberate choice to avoid that cross-feature coupling — the
// duplication is a few lines, the isolation is worth it.
//
// Grid/pixel positioning math (CSS grid columns, percentages) lives in
// lib/gantt.ts, not here — this file is strictly the domain layer:
// visit/phase status, dates, attention grouping, overlap detection,
// arrival-label formatting. See lib/gantt.ts's own header comment for
// the reverse pointer.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// Types (types/index.ts is owned by another agent in this Phase and
// is not edited here — see that file's SchedulePhase/SchedulePhaseWithContact/
// ContactSummary/PhaseColorKey, imported from "@/types" where needed by
// callers; this file defines everything new for trade visits locally).
// ------------------------------------------------------------

export type VisitStatus = "unconfirmed" | "confirmed" | "tentative" | "declined" | "proposed_change";
export type ArrivalSlot = "first_thing" | "midday" | "afternoon";

export interface TradeVisit {
  id: string;
  project_id: string;
  phase_id: string;
  contact_id: string | null;
  start_date: string;
  end_date: string;
  arrival_slot: ArrivalSlot | null;
  arrival_time: string | null;
  status: VisitStatus;
  proposed_start: string | null;
  proposed_end: string | null;
  proposed_slot: ArrivalSlot | null;
  proposed_time: string | null;
  proposed_note: string | null;
  confirm_token: string;
  confirmed_at: string | null;
  confirmed_by: "trade" | "staff" | null;
  reminder_sent_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Lightweight contact summary, same shape as types/index.ts's ContactSummary — redefined here so this file stays import-free of "@/types". */
export interface VisitContactSummary {
  id: string;
  company: string;
  contact_name: string | null;
}

export interface TradeVisitWithContact extends TradeVisit {
  contact: VisitContactSummary | null;
}

/** body accepted by POST /api/projects/[id]/visits. */
export interface CreateVisitInput {
  phase_id: string;
  contact_id?: string | null;
  start_date: string;
  end_date: string;
  arrival_slot?: ArrivalSlot | null;
  arrival_time?: string | null;
  notes?: string | null;
}

/** body accepted by PATCH /api/visits/[id] — partial, editable fields only. */
export interface PatchVisitInput {
  contact_id?: string | null;
  start_date?: string;
  end_date?: string;
  arrival_slot?: ArrivalSlot | null;
  arrival_time?: string | null;
  notes?: string | null;
}

/** body accepted by POST /api/visits/[id]/resolve-proposal. */
export type ResolveProposalInput =
  | { action: "accept" }
  | {
      action: "counter";
      start_date: string;
      end_date: string;
      arrival_slot?: ArrivalSlot | null;
      arrival_time?: string | null;
      note?: string | null;
    };

/** body accepted by POST /api/trade/[token]/respond. */
export type TradeRespondInput =
  | { action: "confirm"; arrival_slot?: ArrivalSlot | null; arrival_time?: string | null }
  | { action: "confirm_different_time"; arrival_slot?: ArrivalSlot | null; arrival_time?: string | null }
  | {
      action: "propose";
      proposed_start: string;
      proposed_end: string;
      proposed_slot?: ArrivalSlot | null;
      proposed_time?: string | null;
      proposed_note?: string | null;
    };

/** A schedule_phases row extended with its kind/cost_section_id and nested visits — see GET /api/projects/[id]/phases. */
export interface SchedulePhaseWithVisitsFields {
  kind: "phase" | "umbrella";
  cost_section_id: string | null;
  visits: TradeVisitWithContact[];
  /** Only populated for kind === 'umbrella': line descriptions (no cost/pricing fields) from the linked "Preliminaries & Site" cost section. */
  cost_section_lines?: string[];
}

/**
 * Full shape of a phase as returned by GET /api/projects/[id]/phases —
 * the existing SchedulePhaseWithContact (types/index.ts, owned by
 * another agent) plus this Phase's additions. Defined here (not in
 * types/index.ts, which this agent must not edit) so both the API
 * route and client components (components/gantt/**) can import a
 * single shared shape without a route file importing from another
 * route file. Mirrors SchedulePhase's fields explicitly rather than
 * `extends`-ing SchedulePhaseWithContact, to avoid importing "@/types"
 * into what is otherwise a dependency-free-of-framework-imports module
 * (this is a plain type-only import, so it carries no runtime
 * dependency — the "dependency-free" goal above is about avoiding
 * Supabase/Next.js imports, not plain shared TypeScript types).
 */
export interface SchedulePhaseWithVisits extends SchedulePhaseWithVisitsFields {
  id: string;
  project_id: string;
  name: string;
  start_date: string;
  end_date: string;
  color_key: "sand" | "charcoal" | "teal" | "amber";
  contact_id: string | null;
  sort: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  contact: VisitContactSummary | null;
}

export interface VisitAttentionGroups {
  /** status === 'proposed_change' — a trade proposed a different date and staff needs to accept/counter. */
  proposed_pending: TradeVisit[];
  /** status in ('unconfirmed','tentative') AND start_date within [today, today+3] inclusive. */
  starting_soon: TradeVisit[];
}

// ------------------------------------------------------------
// Date helpers — date-only (yyyy-mm-dd) string arithmetic, UTC-safe,
// consistent with lib/gantt.ts's own date handling (parses "T00:00:00Z").
// ------------------------------------------------------------

function parseDateOnly(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function todayUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Whole days between `now` (UTC midnight) and a date-only string (positive = future). */
function daysUntilDate(dateStr: string, now: Date): number {
  const target = parseDateOnly(dateStr).getTime();
  const today = todayUtcMidnight(now).getTime();
  return Math.round((target - today) / DAY_MS);
}

/** Monday-aligned start of the week containing `date` (mirrors lib/gantt.ts's startOfWeek — duplicated intentionally, see file header comment). */
function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

// ------------------------------------------------------------
// Needs-attention grouping — GET /api/visits/attention.
// ------------------------------------------------------------

/**
 * Computes the two needs-attention groups for trade visits:
 *
 * - proposed_pending: any visit currently awaiting a staff decision on
 *   a trade's counter-proposal (status === 'proposed_change'). No date
 *   window — a pending proposal needs attention regardless of how far
 *   away the proposed date is.
 *
 * - starting_soon: visits not yet confirmed (status 'unconfirmed' or
 *   'tentative') whose start_date falls within the next 3 days
 *   INCLUSIVE of today (0, 1, 2, or 3 days out) and not in the past —
 *   a visit that starts tomorrow with no confirmation is the one
 *   staff most needs to chase. Declined/confirmed/proposed_change
 *   visits are excluded from this group (declined needs no chasing;
 *   confirmed needs none; proposed_change already surfaces via the
 *   other group).
 */
export function computeVisitAttention(visits: TradeVisit[], now: Date = new Date()): VisitAttentionGroups {
  const proposed_pending: TradeVisit[] = [];
  const starting_soon: TradeVisit[] = [];

  for (const visit of visits) {
    if (visit.status === "proposed_change") {
      proposed_pending.push(visit);
      continue;
    }

    if (visit.status === "unconfirmed" || visit.status === "tentative") {
      const days = daysUntilDate(visit.start_date, now);
      if (days >= 0 && days <= 3) {
        starting_soon.push(visit);
      }
    }
  }

  return { proposed_pending, starting_soon };
}

// ------------------------------------------------------------
// Umbrella band — REMOVED in Fix Round A.
//
// BUILD-SPEC.md "Site Setup umbrella span" (item 3, from Phillip's
// testing): the auto-span-to-min/max-of-every-ordinary-phase behaviour
// this section used to implement (computeUmbrellaBand/UmbrellaBand)
// was WRONG as built — it visually spanned the entire project instead
// of representing "the first few days of setup". That recompute-on-
// read logic has been deleted from both its callers
// (app/api/projects/[id]/phases/route.ts's GET and
// app/(dashboard)/projects/[id]/timeline/page.tsx) — the umbrella
// phase is now seeded ONCE with a short default span (project's
// earliest phase start, or today, + 4 days — see
// lib/phase-template.ts's computeUmbrellaSeedSpan()) and is
// thereafter an ordinary, user-editable schedule_phases row like any
// other phase (PATCH /api/phases/[id] no longer blocks
// name/start_date/end_date edits on umbrella-kind rows either). See
// migration 023_phases_insurance.sql and docs/API.md's "Phase
// unification — Fix Round A" section for the full replacement design.
// ------------------------------------------------------------

// ------------------------------------------------------------
// Arrival label formatting.
// ------------------------------------------------------------

const SLOT_LABELS: Record<ArrivalSlot, string> = {
  first_thing: "First thing",
  midday: "Midday",
  afternoon: "Afternoon",
};

/**
 * Formats a visit's arrival nomination for display — BUILD-SPEC's
 * trade page / reminder email copy. Precedence: an explicit
 * arrival_time (a specific clock time) wins over a slot label, since
 * a trade who nominated "7:30am" wants to see "7:30am", not "First
 * thing". Falls back to "Not yet arranged" when neither is set.
 */
export function formatArrival(slot: ArrivalSlot | null, time: string | null): string {
  if (time) {
    // time is a Postgres `time` column, e.g. "07:30:00" — format as h:mm am/pm.
    const [hStr, mStr] = time.split(":");
    const h = Number(hStr);
    const m = Number(mStr);
    const period = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")}${period}`;
  }
  if (slot) return SLOT_LABELS[slot];
  return "Not yet arranged";
}

// ------------------------------------------------------------
// Overlap detection — "who else is on site" (trade page + reminders).
// ------------------------------------------------------------

/**
 * Definition used here (the spec's wording — "overlapping week" — is
 * ambiguous, so this is the concrete rule this codebase implements):
 *
 * 1. Compute the set of Monday-aligned week-start dates covered by the
 *    subject visit's own [start_date, end_date] range (inclusive —
 *    every week that range touches, even partially).
 * 2. A candidate visit is "overlapping" if ANY Monday-aligned week its
 *    own [start_date, end_date] range touches is also in that set.
 *
 * This is deliberately coarser than day-level overlap — two visits in
 * the same calendar week but on different days (e.g. subject visits
 * Monday, other visit is Thursday of the same week) are still
 * considered "overlapping" for the "who else is on site this week"
 * list, since the point is situational awareness ("who's around this
 * week"), not a scheduling conflict detector.
 */
export function findOverlappingVisits<T extends { id: string; start_date: string; end_date: string; status: VisitStatus; deleted_at: string | null }>(
  subject: T,
  others: T[]
): T[] {
  const subjectWeeks = weekStartsCovered(subject.start_date, subject.end_date);
  const subjectWeekKeys = new Set(subjectWeeks.map((d) => d.getTime()));

  return others.filter((candidate) => {
    if (candidate.id === subject.id) return false;
    if (candidate.deleted_at) return false;
    if (candidate.status === "declined") return false;
    const candidateWeeks = weekStartsCovered(candidate.start_date, candidate.end_date);
    return candidateWeeks.some((d) => subjectWeekKeys.has(d.getTime()));
  });
}

function weekStartsCovered(startDate: string, endDate: string): Date[] {
  const start = startOfWeek(parseDateOnly(startDate));
  const end = startOfWeek(parseDateOnly(endDate));
  const weeks: Date[] = [];
  let cursor = start;
  // Bounded loop — a visit's own date range is already validated
  // end_date >= start_date at the DB layer, and visits are short
  // (days/weeks, not years), so this never runs away in practice; a
  // hard cap keeps it provably bounded regardless.
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 520) {
    weeks.push(cursor);
    cursor = new Date(cursor.getTime() + 7 * DAY_MS);
    guard++;
  }
  return weeks;
}

// ------------------------------------------------------------
// Expiry — shared by the /trade/[token] page and the respond route,
// so both agree on when a visit's public link has expired.
// ------------------------------------------------------------

/**
 * A visit's public confirm link is expired if it has been soft-deleted
 * OR its end_date has already passed (date-only comparison — "today"
 * is still valid, the link only expires the day AFTER end_date).
 */
export function isVisitExpired(visit: { end_date: string; deleted_at: string | null }, now: Date = new Date()): boolean {
  if (visit.deleted_at) return true;
  const today = todayUtcMidnight(now);
  const end = parseDateOnly(visit.end_date);
  return today.getTime() > end.getTime();
}
