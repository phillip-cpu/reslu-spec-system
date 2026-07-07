import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rollupPhaseDatesForGroup } from "@/lib/phase-rollup";
import type { ShiftItemsInput, ShiftItemsResponse, ShiftedTaskResult } from "@/types/board-v3-2";

const MS_PER_DAY = 86_400_000;

function parseDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/**
 * POST /api/phases/[id]/shift-items
 *
 * Board v3.2 — "two-way timeline sync": timeline -> board direction.
 * v3.1 already made board -> timeline flow (lib/phase-rollup.ts's
 * rollupPhaseDatesForGroup, called from every board_tasks write path
 * that can touch booking_date/booking_end_date). This route is the
 * INVERSE: dragging a DERIVED phase bar's BODY on the Timeline (see
 * components/gantt/GanttChart.tsx's commitDrag, which now branches on
 * the same worksDatesLockedPhaseIds prop the edit panel already used to
 * disable its date inputs — same "derived" detection, see that file's
 * doc comment) shifts EVERY task's booking_date/booking_end_date in the
 * phase's linked group by the same day delta, then re-runs the rollup
 * so schedule_phases.start_date/end_date reflect the shifted set
 * immediately (the two directions must never fight each other — this
 * route both writes the tasks AND re-derives the phase from them in one
 * request, rather than relying on a second round-trip).
 *
 * Body: ShiftItemsInput { delta_days }. delta_days is whole days,
 * positive = later, negative = earlier — the exact same day-snapped
 * unit lib/phase-drag.ts's snapDeltaDaysFromPxPerDay already produces
 * for an ordinary phase drag; this route is simply the derived-phase
 * commit path in place of PATCH /api/phases/[id].
 *
 * Only valid for a phase whose linked board_groups row currently has at
 * least one task with a booking_date set (the same "derived" condition
 * GanttChart/lib/phase-rollup.ts already use) — 400 otherwise, since a
 * manual (non-derived) phase has no items to shift and should keep
 * using the plain PATCH /api/phases/[id] path untouched.
 *
 * Per-task error collection: each task's update runs independently (a
 * simple sequential loop, "transaction-ish" per the spec — Supabase's
 * JS client has no multi-row transaction primitive here, and this
 * mirrors every other best-effort multi-row write already in this
 * codebase, e.g. DELETE /api/board-tasks/[id]'s sub-item cascade) so one
 * bad row (e.g. a constraint violation) never aborts the rest of the
 * group's shift — every outcome (success or error) is reported back in
 * `tasks` rather than the whole request 500ing on the first failure.
 *
 * Confirmed-visit re-send affordance: for every task whose booking
 * dates actually changed AND which carries a `visit_id` linked to a
 * trade_visits row currently `status = 'confirmed'`, that visit's
 * start_date/end_date are updated to match the task's new
 * booking_date/booking_end_date (keeping the denormalised pair — see
 * migration 029's board_tasks.booking_date comment — in sync, same
 * discipline POST/DELETE .../book-visit already apply) and both the
 * task id AND its linked visit id are added to `reconfirm_task_ids`/
 * `reconfirm_visit_ids` in the response — the client (GanttChart.tsx)
 * surfaces the SAME "Dates changed — re-send confirmation?" affordance
 * (ReconfirmAffordance.tsx) its own commitVisitDrag already triggers for
 * a direct visit sub-bar drag (keyed by visit id, which is why both
 * forms are returned — see ShiftItemsResponse's own doc comment), just
 * reached via the phase-body-drag path instead. The visit's `status`
 * itself is NOT reset here (unlike POST
 * /api/visits/[id]/resend-confirmation, which only fires on an explicit
 * staff button-press) — this route only ever moves dates and flags the
 * affordance; the actual re-send/status-reset stays a deliberate,
 * separate action.
 *
 * Response: ShiftItemsResponse { tasks, reconfirm_task_ids, reconfirm_visit_ids }.
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
      { error: "This phase has no linked board group — nothing to shift." },
      { status: 400 }
    );
  }

  let body: ShiftItemsInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const deltaDays = Number(body.delta_days);
  if (!Number.isFinite(deltaDays) || !Number.isInteger(deltaDays)) {
    return NextResponse.json({ error: "delta_days must be a whole number" }, { status: 400 });
  }

  const { data: tasks } = await supabase
    .from("board_tasks")
    .select("id,booking_date,booking_end_date,visit_id")
    .eq("phase_group_id", group.id)
    .is("deleted_at", null);

  const withDates = (tasks ?? []).filter((t) => !!t.booking_date);
  if (withDates.length === 0) {
    return NextResponse.json(
      { error: "This phase's linked group has no task dates to shift — dates are not derived." },
      { status: 400 }
    );
  }

  if (deltaDays === 0) {
    return NextResponse.json({ tasks: [], reconfirm_task_ids: [], reconfirm_visit_ids: [] } as ShiftItemsResponse);
  }

  // Best-effort lookup of any linked trade_visits rows, keyed by
  // visit_id, so the loop below can check confirmed-status and keep the
  // denormalised visit dates in sync without a query per task.
  const visitIds = withDates.map((t) => t.visit_id).filter((v): v is string => !!v);
  const visitById = new Map<string, { id: string; status: string; start_date: string; end_date: string }>();
  if (visitIds.length > 0) {
    const { data: visits } = await supabase
      .from("trade_visits")
      .select("id,status,start_date,end_date")
      .in("id", visitIds)
      .is("deleted_at", null);
    for (const v of visits ?? []) visitById.set(v.id, v);
  }

  const results: ShiftedTaskResult[] = [];
  const reconfirmTaskIds: string[] = [];
  const reconfirmVisitIds: string[] = [];

  for (const task of withDates) {
    const nextBookingDate = addDays(task.booking_date as string, deltaDays);
    const nextBookingEndDate = task.booking_end_date ? addDays(task.booking_end_date, deltaDays) : nextBookingDate;

    const { data: updated, error } = await supabase
      .from("board_tasks")
      .update({ booking_date: nextBookingDate, booking_end_date: nextBookingEndDate })
      .eq("id", task.id)
      .is("deleted_at", null)
      .select("id,booking_date,booking_end_date")
      .maybeSingle();

    if (error || !updated) {
      results.push({
        id: task.id,
        booking_date: task.booking_date,
        booking_end_date: task.booking_end_date,
        ok: false,
        error: error?.message ?? "Task not found",
      });
      continue;
    }

    results.push({
      id: updated.id,
      booking_date: updated.booking_date,
      booking_end_date: updated.booking_end_date,
      ok: true,
    });

    // Keep the linked visit's own dates in sync (same pair
    // POST/DELETE .../book-visit already keep denormalised), and flag
    // the re-send-confirmation affordance when it was confirmed.
    if (task.visit_id) {
      const visit = visitById.get(task.visit_id);
      if (visit) {
        try {
          await supabase
            .from("trade_visits")
            .update({ start_date: nextBookingDate, end_date: nextBookingEndDate })
            .eq("id", task.visit_id)
            .is("deleted_at", null);
        } catch (visitError) {
          console.error("shift-items: failed to sync linked visit dates:", visitError);
        }
        if (visit.status === "confirmed") {
          reconfirmTaskIds.push(task.id);
          reconfirmVisitIds.push(visit.id);
        }
      }
    }
  }

  // INVARIANT (see lib/phase-rollup.ts's own header): schedule_phases
  // dates are derived from the min/max works dates of tasks in this
  // group whenever any linked task has works dates set. Best-effort —
  // a rollup failure must never fail this shift, which already
  // committed above — log and swallow.
  try {
    await rollupPhaseDatesForGroup(supabase, group.id);
  } catch (rollupError) {
    console.error("rollupPhaseDatesForGroup failed after shift-items POST:", rollupError);
  }

  return NextResponse.json({
    tasks: results,
    reconfirm_task_ids: reconfirmTaskIds,
    reconfirm_visit_ids: reconfirmVisitIds,
  } as ShiftItemsResponse);
}
