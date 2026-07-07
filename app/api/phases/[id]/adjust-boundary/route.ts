import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rollupPhaseDatesForGroup } from "@/lib/phase-rollup";
import type { AdjustBoundaryInput, AdjustBoundaryResponse } from "@/types/board-v3-2";

/**
 * POST /api/phases/[id]/adjust-boundary
 *
 * Board v3.2 — "Edge-stretch on derived phases re-enabled with item
 * semantics." A derived phase's start/end dates are the min/max of its
 * linked group's task booking dates (lib/phase-rollup.ts) — there is no
 * single "the phase" row to resize the way PATCH /api/phases/[id] does
 * for a manual phase, so dragging an EDGE zone here instead moves only
 * the ONE boundary item that currently defines that edge:
 *   - edge: 'start' -> the task with the EARLIEST booking_date has its
 *     booking_date moved to `new_date` (its booking_end_date, if any,
 *     is untouched).
 *   - edge: 'end' -> the task with the LATEST effective end date
 *     (booking_end_date, falling back to booking_date when a task has
 *     no distinct end) has that end date moved to `new_date` (its
 *     booking_date is untouched).
 * This mirrors lib/phase-drag.ts's applyDrag resize-start/resize-end
 * modes one level down (a single item's date, not the whole phase's
 * range) — GanttChart.tsx's tooltip on these edge zones reads "adjusts
 * first item" / "adjusts last item" respectively, so the interaction is
 * self-documenting rather than surprising.
 *
 * Validation: `new_date` must keep the boundary item's own start <= its
 * own end (400 otherwise — e.g. dragging the start edge past that same
 * item's own end_date, or the end edge before its own start_date, per
 * BUILD-SPEC "validated (start<=its end, etc.)"). Deliberately does NOT
 * also enforce the boundary item's new date stays within/beyond the
 * OTHER items' range — e.g. moving the first item's start later than
 * the second-earliest item's start is allowed and simply changes which
 * item is "earliest" for the NEXT rollup read, exactly as if that date
 * had been edited directly on the Board (no different invariant exists
 * there today).
 *
 * If exactly one task ties for earliest/latest, that task is the
 * boundary item unambiguously; a tie is broken by lowest `id` (stable,
 * deterministic — matches no particular business meaning, just avoids
 * an arbitrary/unstable pick across requests).
 *
 * Confirmed-visit re-send affordance: same as POST
 * /api/phases/[id]/shift-items — if the boundary task carries a
 * `visit_id` linked to a trade_visits row currently `status =
 * 'confirmed'`, that visit's matching date is updated to stay in sync
 * and both the task id AND the visit id are returned (`reconfirm_task_ids`/
 * `reconfirm_visit_ids`) for the client to surface the existing
 * per-visit "Dates changed — re-send confirmation?" affordance (keyed
 * by visit id — see ShiftItemsResponse's doc comment for why both forms
 * are returned).
 *
 * Body: AdjustBoundaryInput { edge, new_date }. Response:
 * AdjustBoundaryResponse { task, reconfirm_task_ids, reconfirm_visit_ids }. Rollup re-runs
 * afterwards (best-effort, same as every other rollup call site).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: phaseId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: phase } = await supabase
    .from("schedule_phases")
    .select("id,project_id")
    .eq("id", phaseId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!phase) {
    return NextResponse.json({ error: "Phase not found" }, { status: 404 });
  }

  const { data: group } = await supabase
    .from("board_groups")
    .select("id")
    .eq("phase_id", phaseId)
    .maybeSingle();
  if (!group) {
    return NextResponse.json(
      { error: "This phase has no linked board group — nothing to adjust." },
      { status: 400 }
    );
  }

  let body: AdjustBoundaryInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.edge !== "start" && body.edge !== "end") {
    return NextResponse.json({ error: "edge must be 'start' or 'end'" }, { status: 400 });
  }
  if (typeof body.new_date !== "string" || !body.new_date) {
    return NextResponse.json({ error: "new_date is required" }, { status: 400 });
  }

  const { data: tasks } = await supabase
    .from("board_tasks")
    .select("id,booking_date,booking_end_date,visit_id")
    .eq("phase_group_id", group.id)
    .is("deleted_at", null);

  const withDates = (tasks ?? []).filter(
    (t): t is { id: string; booking_date: string; booking_end_date: string | null; visit_id: string | null } =>
      !!t.booking_date
  );
  if (withDates.length === 0) {
    return NextResponse.json(
      { error: "This phase's linked group has no task dates to adjust — dates are not derived." },
      { status: 400 }
    );
  }

  let boundaryTask: { id: string; booking_date: string; booking_end_date: string | null; visit_id: string | null };
  if (body.edge === "start") {
    boundaryTask = withDates.reduce((earliest, t) =>
      t.booking_date < earliest.booking_date || (t.booking_date === earliest.booking_date && t.id < earliest.id)
        ? t
        : earliest
    );
    const ownEnd = boundaryTask.booking_end_date ?? boundaryTask.booking_date;
    if (body.new_date > ownEnd) {
      return NextResponse.json(
        { error: "Start date cannot be after this item's own end date" },
        { status: 400 }
      );
    }
  } else {
    boundaryTask = withDates.reduce((latest, t) => {
      const tEnd = t.booking_end_date ?? t.booking_date;
      const latestEnd = latest.booking_end_date ?? latest.booking_date;
      return tEnd > latestEnd || (tEnd === latestEnd && t.id < latest.id) ? t : latest;
    });
    if (body.new_date < boundaryTask.booking_date) {
      return NextResponse.json(
        { error: "End date cannot be before this item's own start date" },
        { status: 400 }
      );
    }
  }

  const update =
    body.edge === "start" ? { booking_date: body.new_date } : { booking_end_date: body.new_date };

  const { data: updated, error } = await supabase
    .from("board_tasks")
    .update(update)
    .eq("id", boundaryTask.id)
    .is("deleted_at", null)
    .select("id,booking_date,booking_end_date")
    .maybeSingle();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Task not found" }, { status: 500 });
  }

  const reconfirmTaskIds: string[] = [];
  const reconfirmVisitIds: string[] = [];
  if (boundaryTask.visit_id) {
    const { data: visit } = await supabase
      .from("trade_visits")
      .select("id,status")
      .eq("id", boundaryTask.visit_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (visit) {
      try {
        await supabase
          .from("trade_visits")
          .update(
            body.edge === "start" ? { start_date: body.new_date } : { end_date: body.new_date }
          )
          .eq("id", boundaryTask.visit_id)
          .is("deleted_at", null);
      } catch (visitError) {
        console.error("adjust-boundary: failed to sync linked visit dates:", visitError);
      }
      if (visit.status === "confirmed") {
        reconfirmTaskIds.push(boundaryTask.id);
        reconfirmVisitIds.push(visit.id);
      }
    }
  }

  // INVARIANT (see lib/phase-rollup.ts's own header): schedule_phases
  // dates are derived from the min/max works dates of tasks in this
  // group whenever any linked task has works dates set. Best-effort —
  // a rollup failure must never fail this adjustment, which already
  // committed above — log and swallow.
  try {
    await rollupPhaseDatesForGroup(supabase, group.id);
  } catch (rollupError) {
    console.error("rollupPhaseDatesForGroup failed after adjust-boundary POST:", rollupError);
  }

  return NextResponse.json({
    task: updated,
    reconfirm_task_ids: reconfirmTaskIds,
    reconfirm_visit_ids: reconfirmVisitIds,
  } as AdjustBoundaryResponse);
}
