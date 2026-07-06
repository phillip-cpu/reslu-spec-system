// ============================================================
// RESLU Spec System — Board cockpit round (7 July 2026) shared domain
// logic. Pure, dependency-free helpers — no Supabase/Next imports,
// plain data in/out — mirroring lib/trade-visits.ts / lib/insurance.ts
// / lib/leads.ts's exact shape so this round's needs-attention
// thresholds can never drift between server and any future client-side
// use (e.g. a live preview before the API round-trip resolves).
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function todayUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** True if `dateStr` (a date-only yyyy-mm-dd string) is strictly before today. */
export function isDateOnlyPast(dateStr: string, now: Date = new Date()): boolean {
  return parseDateOnly(dateStr).getTime() < todayUtcMidnight(now).getTime();
}

// ------------------------------------------------------------
// Milestone-complete diary prompt trigger
// ------------------------------------------------------------

/**
 * Which column NAMES count as "done" for the purposes of the
 * milestone-complete diary prompt (BUILD-SPEC.md chat-agreed
 * improvement: "completion prompts diary"). Matched case-insensitively
 * against board_columns.name — column sets are per-project/fully
 * editable (migration 013), so this cannot key off a fixed column_id;
 * matching by name against the small set of labels every project's
 * default seed uses (DEFAULT_COLUMNS_V2, types/phase-12a-b.ts:
 * "Waiting"/"To Do"/"In Progress"/"Done") is the same class of
 * heuristic BUILD-SPEC.md's own "Board v2" column-seed logic already
 * accepts elsewhere in this codebase (matching by name, not id, for a
 * team-renameable list). A project that renames its "Done" column to
 * something else simply stops triggering the prompt for future
 * moves — acceptable, since the prompt is a helpful nudge, not a
 * required workflow gate (staff can always start a diary draft
 * manually from the Diary panel regardless).
 */
const DONE_COLUMN_NAMES = new Set(["done", "complete", "completed"]);

/**
 * True when moving a milestone-kind card INTO a column named like
 * "Done" should surface the "create a diary entry?" prompt. Only fires
 * on the transition (the caller passes the PREVIOUS column name so a
 * card already sitting in Done that gets re-saved for an unrelated
 * reason doesn't re-prompt every time) and only for kind === 'milestone'
 * — an ordinary task moving to Done is just an ordinary task, no diary
 * significance (BUILD-SPEC.md's milestone-diary link is specific to
 * milestone cards, not every completed card).
 */
export function shouldPromptMilestoneDiary(
  kind: "task" | "milestone",
  previousColumnName: string | null,
  nextColumnName: string
): boolean {
  if (kind !== "milestone") return false;
  const wasDone = previousColumnName ? DONE_COLUMN_NAMES.has(previousColumnName.trim().toLowerCase()) : false;
  const isDone = DONE_COLUMN_NAMES.has(nextColumnName.trim().toLowerCase());
  return isDone && !wasDone;
}

// ------------------------------------------------------------
// Aria booking-chase attention feed — 'bookings_overdue'
// ------------------------------------------------------------

export interface BookingsOverdueSourceTask {
  id: string;
  title: string;
  project_id: string;
  kind: "task" | "milestone";
  due_date: string | null;
  booking_date: string | null;
  visit_status: "unconfirmed" | "confirmed" | "tentative" | "declined" | "proposed_change" | null;
  contact_id: string | null;
}

export interface BookingsOverdueComputed {
  task_id: string;
  reason: "booking_unconfirmed" | "milestone_overdue";
  date: string;
}

/**
 * Computes which board_tasks rows belong in the 'bookings_overdue'
 * Aria attention feed (BUILD-SPEC.md chat-agreed improvement: "Aria
 * booking-chase attention feed 'bookings_overdue'"). Two reasons a
 * card surfaces here, mirroring lib/trade-visits.ts's
 * computeVisitAttention()'s own "two distinct reasons, one flat
 * result" shape:
 *
 * - booking_unconfirmed: has a booking_date in the past AND the
 *   linked visit's status is still unconfirmed/tentative/
 *   proposed_change (a confirmed or declined visit needs no chasing —
 *   confirmed is resolved, declined is a dead end staff already knows
 *   about via the visit itself, not something to keep chasing).
 * - milestone_overdue: kind === 'milestone' with a due_date in the
 *   past (milestones have no booking of their own necessarily, but an
 *   overdue milestone is exactly the kind of thing a booking-chase
 *   feed should also surface — a milestone is often "trade X must have
 *   finished by date Y", which is itself scheduling-chase territory).
 *
 * A card matching BOTH conditions (a milestone with both an overdue
 * booking and an overdue due_date) surfaces once, reason
 * 'booking_unconfirmed' taking precedence (the unconfirmed booking is
 * the more actionable of the two — confirming it is the concrete next
 * step; the milestone due date follows from the booking anyway).
 */
export function computeBookingsOverdue(
  tasks: BookingsOverdueSourceTask[],
  now: Date = new Date()
): BookingsOverdueComputed[] {
  const results: BookingsOverdueComputed[] = [];

  for (const task of tasks) {
    if (
      task.booking_date &&
      isDateOnlyPast(task.booking_date, now) &&
      (task.visit_status === "unconfirmed" || task.visit_status === "tentative" || task.visit_status === "proposed_change")
    ) {
      results.push({ task_id: task.id, reason: "booking_unconfirmed", date: task.booking_date });
      continue;
    }
    if (task.kind === "milestone" && task.due_date && isDateOnlyPast(task.due_date, now)) {
      results.push({ task_id: task.id, reason: "milestone_overdue", date: task.due_date });
    }
  }

  return results;
}

// ------------------------------------------------------------
// Materials price-refresh chase — 'price_refreshes_pending' attention
// feed (companion to 'bookings_overdue' above — same mechanism file,
// same thin-lib-function + thin-route shape). Migration 029 PART 3:
// materials.price_refresh_status='needs_aria' + price_refresh_requested_at.
// ------------------------------------------------------------

export interface MaterialNeedingAriaSourceRow {
  id: string;
  name: string;
  price_refresh_status: string | null;
  price_refresh_requested_at: string | null;
}

export interface MaterialNeedingAria {
  material_id: string;
  name: string;
  /** When the failed refresh attempt happened — always non-null for a row this function returns (a null price_refresh_requested_at alongside price_refresh_status='needs_aria' shouldn't normally happen, but is defensively excluded rather than surfaced with a fabricated date). */
  requested_at: string;
}

/**
 * Every material whose last automated price refresh failed and is
 * still waiting on Aria/a human (price_refresh_status='needs_aria') —
 * simple pass-through filter (no date-threshold logic needed, unlike
 * computeBookingsOverdue's "in the past" checks: a needs_aria row is
 * ALWAYS actionable the moment it's set, there's no "not yet due"
 * state for it) kept as its own pure function purely for symmetry with
 * every other attention-feed compute function in this codebase, and so
 * a future date-based threshold (e.g. "only chase if >24h old") can be
 * added here without touching the route.
 */
export function computeMaterialsNeedingAria(
  materials: MaterialNeedingAriaSourceRow[]
): MaterialNeedingAria[] {
  const results: MaterialNeedingAria[] = [];
  for (const m of materials) {
    if (m.price_refresh_status === "needs_aria" && m.price_refresh_requested_at) {
      results.push({ material_id: m.id, name: m.name, requested_at: m.price_refresh_requested_at });
    }
  }
  return results;
}
