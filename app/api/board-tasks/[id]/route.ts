import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rollupPhaseDatesForGroup } from "@/lib/phase-rollup";
import type { PatchBoardTaskV33Input } from "@/types/board-v3-3";

const EDITABLE_FIELDS = new Set([
  "column_id",
  "title",
  "description",
  "contact_id",
  "due_date",
  // migration 041 ("Small pair" item 2) — optional wall-clock reminder
  // time alongside due_date. Plain PATCHable field, same "trim to
  // null" string handling every other nullable text column in this
  // route's generic update loop already gets — no extra validation
  // beyond that (an invalid HH:MM string is rejected by Postgres'
  // `time` column type itself, surfacing as a normal 500/23xxx error
  // like any other malformed write to this route).
  "due_time",
  "sort",
  "phase_group_id",
  // Board cockpit round (migration 029): milestone toggle.
  "kind",
  // Board v3.3 — "placeholder dates + booking actually sends" (8 July
  // 2026): booking_date/booking_end_date REJOIN this whitelist,
  // REVERSING the v3.1 deviation recorded directly above until this
  // edit. The prior comment here (still visible in migration 029's own
  // column comments on board_tasks.booking_date/booking_end_date, which
  // this route does not — and cannot, per this round's "no migration"
  // constraint — rewrite) claimed these two columns were "only ever
  // written via POST/DELETE .../book-visit". That was true through
  // v3.1/v3.2 but is BY DESIGN no longer the whole story: works dates
  // are meant to be freely editable placeholders on a card that has NO
  // linked visit (WorksDateCell, components/board/DateCell.tsx, now
  // opens a start/end popover that commits straight through this PATCH,
  // the same way DueDateCell's popover always has) — v3.1's read-only
  // treatment was itself the deviation from the original spec, not the
  // other way around. Book-visit's own single-write-path guarantee is
  // preserved for the ONE case it actually matters — a task WITH a
  // linked visit — by the sync block below (search "WORKS-DATE / VISIT
  // SYNC"), which pushes any direct booking_date/booking_end_date PATCH
  // through to the linked trade_visits row immediately, so the two can
  // never drift apart; POST/DELETE .../book-visit remain the only way
  // to CREATE or REMOVE that link in the first place, only the DATES
  // themselves are now dual-write (this route AND book-visit), not the
  // link.
  "booking_date",
  "booking_end_date",
]);

const VALID_KINDS = new Set(["task", "milestone"]);

/**
 * PATCH /api/board-tasks/[id]
 * body: PatchBoardTaskV33Input (partial) — used for both field edits
 * (title/description/contact/due_date/phase_group_id/booking_date/
 * booking_end_date) AND drag-drop moves (column_id + sort together).
 * Response: { task, reconfirm_visit_ids? }. When `column_id` or
 * `phase_group_id` is supplied, it's validated against the task's own
 * project (a card can never be dragged into another project's
 * column/group via a forged id). Aria-relevant (Aria operates boards).
 *
 * Board v2 — multi-assignee (migration 020): `assignee_ids` is handled
 * SEPARATELY from the generic EDITABLE_FIELDS update loop below, since
 * it's a full-replace of the board_task_assignees join rows rather
 * than a plain column write. Passing `assignee_ids: []` clears all
 * assignees; omitting the key entirely leaves the current assignee set
 * untouched. board_tasks.assignee_id (deprecated single-assignee
 * column, migration 020) is kept in sync as a courtesy — set to the
 * first id in the new list, or null — but is never read by this route
 * or any Board v2 UI; see migration 020's deprecation comment.
 *
 * Board v3.3 — WORKS-DATE / VISIT SYNC: `booking_date`/
 * `booking_end_date` are now plain PATCHable fields (see
 * EDITABLE_FIELDS's own doc comment above for the full "reverses v3.1"
 * rationale). Validated end >= start whenever the RESULTING row would
 * have both set (covers every combination: both supplied this request,
 * only one supplied against an existing value for the other, etc — the
 * check runs against the post-merge values, not just the two keys this
 * request happens to touch). When the task carries a `visit_id`, a
 * direct works-date edit is NOT a placeholder edit — this card's dates
 * ARE the booked visit's dates (denormalized copies, migration 029) —
 * so the write pushes through to the linked trade_visits row in the
 * same request (single logical commit, best-effort on the visit side
 * per this codebase's established "primary write already succeeded,
 * don't fail the request over a secondary sync" discipline — see
 * shift-items/adjust-boundary's identical pattern, which this block
 * mirrors). If that visit was `status = 'confirmed'`, its id is
 * returned in `reconfirm_visit_ids` so the client can surface the same
 * "Dates changed — re-send confirmation?" affordance shift-items/
 * adjust-boundary already trigger — status itself is left untouched
 * here (re-sending is a deliberate, separate staff action via POST
 * /api/visits/[id]/resend-confirmation, never auto-fired by a date
 * edit). A task with NO visit_id is a pure placeholder — its dates
 * simply write to board_tasks and nothing else.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: existing } = await supabase
    .from("board_tasks")
    .select("id,project_id,column_id,phase_group_id,visit_id,booking_date,booking_end_date")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: PatchBoardTaskV33Input;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.column_id && body.column_id !== existing.column_id) {
    const { data: column } = await supabase
      .from("board_columns")
      .select("id")
      .eq("id", body.column_id)
      .eq("project_id", existing.project_id)
      .single();
    if (!column) {
      return NextResponse.json(
        { error: "column_id does not belong to this project" },
        { status: 400 }
      );
    }
  }

  if (body.phase_group_id) {
    const { data: group } = await supabase
      .from("board_groups")
      .select("id")
      .eq("id", body.phase_group_id)
      .eq("project_id", existing.project_id)
      .single();
    if (!group) {
      return NextResponse.json(
        { error: "phase_group_id does not belong to this project" },
        { status: 400 }
      );
    }
  }

  // Board v3.3 — validate the RESULTING booking_date/booking_end_date
  // pair (post-merge with whichever of the two the caller didn't touch
  // this request), not just whichever key(s) appear in `body` — e.g.
  // PATCHing only booking_end_date against an existing later
  // booking_date must still be rejected. `null` on either side means
  // "no range to compare" (a single date, or neither set) — only reject
  // when BOTH resolve to a real date and end < start.
  if ("booking_date" in body || "booking_end_date" in body) {
    const nextStart = "booking_date" in body ? body.booking_date ?? null : existing.booking_date;
    const nextEnd = "booking_end_date" in body ? body.booking_end_date ?? null : existing.booking_end_date;
    if (nextStart && nextEnd && nextEnd < nextStart) {
      return NextResponse.json(
        { error: "booking_end_date must be on or after booking_date" },
        { status: 400 }
      );
    }
  }

  if (body.assignee_ids !== undefined) {
    if (!Array.isArray(body.assignee_ids)) {
      return NextResponse.json({ error: "assignee_ids must be an array" }, { status: 400 });
    }
    const { error: deleteError } = await supabase
      .from("board_task_assignees")
      .delete()
      .eq("task_id", id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    if (body.assignee_ids.length > 0) {
      const { error: insertError } = await supabase
        .from("board_task_assignees")
        .insert(body.assignee_ids.map((profileId) => ({ task_id: id, profile_id: profileId })));
      if (insertError) {
        const status = insertError.code === "23503" ? 400 : 500;
        return NextResponse.json({ error: insertError.message }, { status });
      }
    }
    await supabase
      .from("board_tasks")
      .update({ assignee_id: body.assignee_ids[0] ?? null })
      .eq("id", id);
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (key === "sort") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ error: "sort must be a number" }, { status: 400 });
      }
      update.sort = n;
    } else if (key === "title") {
      const trimmed = typeof raw === "string" ? raw.trim() : raw;
      if (!trimmed) {
        return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      }
      update.title = trimmed;
    } else if (key === "kind") {
      if (typeof raw !== "string" || !VALID_KINDS.has(raw)) {
        return NextResponse.json({ error: "kind must be 'task' or 'milestone'" }, { status: 400 });
      }
      update.kind = raw;
    } else if (typeof raw === "string") {
      update[key] = raw.trim() || null;
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0 && body.assignee_ids === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: task, error } =
    Object.keys(update).length > 0
      ? await supabase
          .from("board_tasks")
          .update(update)
          .eq("id", id)
          .is("deleted_at", null)
          .select()
          .single()
      : await supabase.from("board_tasks").select("*").eq("id", id).is("deleted_at", null).single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  // Board v3.3 — WORKS-DATE / VISIT SYNC (see this route's own PATCH
  // doc comment above for the full rationale): a direct booking_date/
  // booking_end_date write on a task that carries a visit_id pushes the
  // same new dates onto the linked trade_visits row, and flags a
  // re-confirm affordance if that visit was 'confirmed' — identical
  // shape to shift-items/adjust-boundary's own sync block. Only runs
  // when this request actually touched a booking date AND the task has
  // a visit_id (a placeholder-only task with no visit has nothing to
  // sync). Best-effort: never fails this PATCH, which already
  // committed above.
  const reconfirmVisitIds: string[] = [];
  const bookingDatesChanged = "booking_date" in update || "booking_end_date" in update;
  if (bookingDatesChanged && task.visit_id) {
    try {
      const { data: visit } = await supabase
        .from("trade_visits")
        .select("id,status")
        .eq("id", task.visit_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (visit) {
        await supabase
          .from("trade_visits")
          .update({ start_date: task.booking_date, end_date: task.booking_end_date ?? task.booking_date })
          .eq("id", task.visit_id)
          .is("deleted_at", null);
        if (visit.status === "confirmed") {
          reconfirmVisitIds.push(visit.id);
        }
      }
    } catch (visitSyncError) {
      console.error("board-task PATCH: failed to sync linked visit dates:", visitSyncError);
    }
  }

  // INVARIANT: schedule_phases.start_date/end_date are derived from the
  // min/max works dates (board_tasks.booking_date/booking_end_date) of
  // tasks in groups linked to this phase, whenever any linked task has
  // works dates set. This keeps Timeline (lib/gantt.ts) consistent with
  // the board's grouped-list rollup display. A phase_group_id change
  // (drag/drop between groups, or the row's "Phase" select) moves a
  // task's works dates OUT of its old group's rollup input set and INTO
  // its new group's — both sides are recomputed. Board v3.3: a direct
  // booking_date/booking_end_date PATCH (now possible — see
  // EDITABLE_FIELDS above) also re-runs the rollup for the task's
  // (single, unchanged-by-this-request) group, same as book-visit's own
  // POST/DELETE always have. Best-effort: a rollup failure must never
  // fail this PATCH, which already succeeded above — log and swallow.
  try {
    if ("phase_group_id" in update) {
      if (existing.phase_group_id !== task.phase_group_id) {
        await rollupPhaseDatesForGroup(supabase, existing.phase_group_id);
      }
      await rollupPhaseDatesForGroup(supabase, task.phase_group_id);
    } else if (bookingDatesChanged) {
      await rollupPhaseDatesForGroup(supabase, task.phase_group_id);
    }
  } catch (rollupError) {
    console.error("rollupPhaseDatesForGroup failed after board-task PATCH:", rollupError);
  }

  return NextResponse.json({ task, reconfirm_visit_ids: reconfirmVisitIds });
}

/**
 * DELETE /api/board-tasks/[id]
 * Soft-delete (deleted_at) — parity with items/cost_lines/variations.
 *
 * Board v3 — Monday parity round: if this task has any sub-items
 * (board_tasks rows with parent_task_id = this id), they are ALSO
 * soft-deleted in the same request — a sub-item has no independent
 * meaning once its parent card disappears from every board view (it
 * would otherwise become an invisible orphan: still a live row, but
 * unreachable from any UI, since every sub-item is only ever rendered
 * nested under its parent's row — see GroupRows,
 * components/board/ProjectBoard.tsx). This mirrors migration 031's own
 * ON DELETE CASCADE (which only fires on a genuine hard delete, never
 * used in normal operation) at the soft-delete layer this app actually
 * uses day to day. Best-effort: a failure soft-deleting the children
 * does not block the parent's own deletion (same "one row failing
 * doesn't abort the rest" discipline this codebase's seed/backfill
 * paths already use) — it is reported as a non-fatal `warning` on the
 * response rather than a 500, since the parent's own delete already
 * succeeded by that point.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Board v3.1 — rollup: read the task's phase_group_id BEFORE the
  // soft-delete below so a group whose only works-dated task is this
  // one gets recomputed (falling back to "no tasks have works dates"
  // once this task is gone, per rollupPhaseDatesForGroup's own no-op
  // rule) rather than silently keeping a stale phase range forever.
  const { data: taskBeforeDelete } = await supabase
    .from("board_tasks")
    .select("phase_group_id")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("board_tasks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // INVARIANT: schedule_phases.start_date/end_date are derived from the
  // min/max works dates (board_tasks.booking_date/booking_end_date) of
  // tasks in groups linked to this phase, whenever any linked task has
  // works dates set. This keeps Timeline (lib/gantt.ts) consistent with
  // the board's grouped-list rollup display. Best-effort: a rollup
  // failure must never fail this delete, which already succeeded above
  // — log and swallow.
  try {
    await rollupPhaseDatesForGroup(supabase, taskBeforeDelete?.phase_group_id ?? null);
  } catch (rollupError) {
    console.error("rollupPhaseDatesForGroup failed after board-task DELETE:", rollupError);
  }

  const { error: childError } = await supabase
    .from("board_tasks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("parent_task_id", id)
    .is("deleted_at", null);

  if (childError) {
    return NextResponse.json({ ok: true, warning: `Card removed, but could not remove all sub-items: ${childError.message}` });
  }

  return NextResponse.json({ ok: true });
}
