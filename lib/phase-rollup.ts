import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// RESLU Spec System — Board v3.1 "display-first cells" round —
// phase date rollup. Pure-ish server helper (one Supabase client
// param, same untyped-generic-SupabaseClient convention as
// lib/phase-seed.ts's seedPhaseTemplateIfEmpty()/
// applyStageTemplateToEmptyGroups()) shared by every board_tasks write
// path that can change a task's works-date footprint within a group:
// PATCH /api/board-tasks/[id] (title/due_date/phase_group_id/etc —
// included for completeness/future-proofing even though this route's
// EDITABLE_FIELDS whitelist does not currently accept booking_date/
// booking_end_date directly), POST /api/board-tasks/[id]/book-visit
// (books a trade visit — sets booking_date/booking_end_date), DELETE
// /api/board-tasks/[id]/book-visit (unlinks a booking — clears them),
// POST /api/projects/[id]/board (creates a task — a brand new task
// with no booking_date yet cannot change the rollup, but calling this
// after creation keeps every write path uniform and future-proof if a
// task is ever created already carrying booking dates), and DELETE
// /api/board-tasks/[id] (soft-deletes a task — removes it from the
// rollup's input set).
//
// INVARIANT: schedule_phases.start_date/end_date are derived from the
// min/max works dates (board_tasks.booking_date /
// board_tasks.booking_end_date) of tasks in groups linked to this
// phase, whenever any linked task has works dates set. This keeps
// Timeline (lib/gantt.ts) consistent with the board's grouped-list
// rollup display (components/board/ProjectBoard.tsx's GroupTable
// header, which shows the identical computed range read-only whenever
// any task in the group has works dates).
//
// Best-effort, always: every route calling this wraps it in try/catch
// and logs-and-swallows any error — a rollup failure must never fail
// the primary task write (the booking/task mutation itself already
// succeeded by the time this runs).
// ============================================================

/**
 * Recomputes and writes schedule_phases.start_date/end_date for the
 * phase linked to `phaseGroupId`'s board_groups row, from the min/max
 * works dates of every non-deleted task currently in that group:
 *   - start_date = min(booking_date) across tasks with booking_date set.
 *   - end_date = max(booking_end_date, falling back to booking_date
 *     when a task has no distinct end date) across that same set.
 *
 * No-ops (returns without writing anything) when:
 *   - `phaseGroupId` is null/undefined (task isn't in a group).
 *   - the group has no linked phase_id (nothing to roll up onto).
 *   - zero tasks in the group currently have a booking_date set (per
 *     this round's spec: the rollup only takes over "whenever any
 *     linked task has works dates set" — with none set, the phase's
 *     dates stay whatever they were, either manually set or untouched,
 *     and the grouped-list header/Timeline edit panel both fall back
 *     to their own manual/editable behaviour).
 *
 * Never throws for a "nothing to do" case — only a genuine Supabase
 * error propagates, and every call site wraps this in its own
 * try/catch per the file header's best-effort discipline.
 */
export async function rollupPhaseDatesForGroup(
  supabase: SupabaseClient,
  phaseGroupId: string | null | undefined
): Promise<void> {
  if (!phaseGroupId) return;

  const { data: group } = await supabase
    .from("board_groups")
    .select("id,phase_id")
    .eq("id", phaseGroupId)
    .maybeSingle();
  if (!group?.phase_id) return;

  const { data: tasks } = await supabase
    .from("board_tasks")
    .select("booking_date,booking_end_date")
    .eq("phase_group_id", phaseGroupId)
    .is("deleted_at", null);

  const withDates = (tasks ?? []).filter(
    (t): t is { booking_date: string; booking_end_date: string | null } => !!t.booking_date
  );
  if (withDates.length === 0) return;

  const starts = withDates.map((t) => t.booking_date);
  const ends = withDates.map((t) => t.booking_end_date ?? t.booking_date);

  const start_date = starts.reduce((min, d) => (d < min ? d : min), starts[0]);
  const end_date = ends.reduce((max, d) => (d > max ? d : max), ends[0]);

  await supabase.from("schedule_phases").update({ start_date, end_date }).eq("id", group.phase_id);
}
