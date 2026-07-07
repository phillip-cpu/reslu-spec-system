import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchBoardTaskInputV2 } from "@/types/phase-12a-b";

const EDITABLE_FIELDS = new Set([
  "column_id",
  "title",
  "description",
  "contact_id",
  "due_date",
  "sort",
  "phase_group_id",
  // Board cockpit round (migration 029): milestone toggle. Note
  // booking_date/booking_end_date/visit_id are deliberately NOT in this
  // whitelist — those are only ever written via POST/DELETE
  // /api/board-tasks/[id]/book-visit, which keeps the trio in sync with
  // the linked trade_visits row (see that route's own doc comment);
  // allowing a bare PATCH to touch them here would let a caller set a
  // booking_date with no linked visit at all, or desync it from the
  // visit's real dates.
  "kind",
]);

const VALID_KINDS = new Set(["task", "milestone"]);

/**
 * PATCH /api/board-tasks/[id]
 * body: PatchBoardTaskInputV2 (partial) — used for both field edits
 * (title/description/contact/due_date/phase_group_id) AND drag-drop
 * moves (column_id + sort together). Response: { task }. When
 * `column_id` or `phase_group_id` is supplied, it's validated against
 * the task's own project (a card can never be dragged into another
 * project's column/group via a forged id). Aria-relevant (Aria
 * operates boards).
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
    .select("id,project_id,column_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: PatchBoardTaskInputV2;
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

  return NextResponse.json({ task });
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

  const { error } = await supabase
    .from("board_tasks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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
