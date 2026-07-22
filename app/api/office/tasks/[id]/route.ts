import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_ARCHIVED_GROUP_NAME } from "@/types/phase-13";
import type { PatchOfficeTaskInput } from "@/types/phase-13";

// migration 041 — "due_time" added to parity with due_date (see
// PatchOfficeTaskInput's own doc comment, types/phase-13.ts).
const EDITABLE_FIELDS = new Set(["title", "description", "due_date", "due_time", "sort", "group_id"]);

/**
 * PATCH /api/office/tasks/[id]
 * body: PatchOfficeTaskInput (partial). Response: { task } (plain
 * office_tasks row — the caller already holds assignees/subtasks
 * client-side and merges this patch in, same pattern as
 * PATCH /api/board-tasks/[id]).
 *
 * Complete -> Archive (BUILD-SPEC.md §"13 Office" / this task's brief
 * point 2): passing `complete: true` sets `completed_at = now()` AND
 * moves the task into the Archived group, remembering the group it
 * came from on `prev_group_id` (migration 021's own column, chosen over
 * encoding it into `description` text — see that migration's comment).
 * Passing `complete: false` reverses this exactly: clears
 * `completed_at`, restores `group_id` from `prev_group_id`, and clears
 * `prev_group_id` back to null. Both actions are refused (409) for
 * `kind: 'rule'` cards — standing rule cards are never completable, per
 * the brief's "un-completable" requirement — enforced here rather than
 * a DB CHECK constraint so the error message can explain why.
 *
 * A plain `group_id` field edit (e.g. dragging a card between
 * department groups in the UI, NOT via the complete action) is allowed
 * independently of `complete` — but moving a task INTO the Archived
 * group this way does NOT set completed_at (only the explicit
 * `complete: true` action does that); moving a task OUT of Archived
 * this way does NOT auto-restore prev_group_id bookkeeping (that only
 * happens via `complete: false`). This keeps "manually filed under
 * Archived" and "completed and auto-archived" distinguishable in the
 * data even though both end up with group_id = Archived.
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
    .from("office_tasks")
    .select("id,group_id,prev_group_id,kind,completed_at")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: PatchOfficeTaskInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.group_id) {
    const { data: group } = await supabase
      .from("office_groups")
      .select("id")
      .eq("id", body.group_id)
      .is("deleted_at", null)
      .single();
    if (!group) {
      return NextResponse.json({ error: "group_id does not exist" }, { status: 400 });
    }
  }

  const update: Record<string, unknown> = {};

  if (body.complete !== undefined) {
    if (existing.kind === "rule") {
      return NextResponse.json(
        { error: "Standing rule cards cannot be completed." },
        { status: 409 }
      );
    }

    if (body.complete) {
      const { data: archived } = await supabase
        .from("office_groups")
        .select("id")
        .eq("name", OFFICE_ARCHIVED_GROUP_NAME)
        .is("deleted_at", null)
        .single();
      if (!archived) {
        return NextResponse.json(
          { error: "Archived group not found — cannot complete task." },
          { status: 500 }
        );
      }
      update.completed_at = new Date().toISOString();
      update.prev_group_id = existing.group_id;
      update.group_id = archived.id;
      // Keep due_date as completion history at the source. My Work removes
      // this row from its active view using completed_at.
    } else {
      update.completed_at = null;
      update.group_id = existing.prev_group_id ?? existing.group_id;
      update.prev_group_id = null;
    }
  }

  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    // group_id/sort may already be set by the complete/uncomplete branch
    // above — an explicit field in the same request is allowed to
    // layer on top (e.g. a client renaming a task while also completing
    // it in one PATCH), so this loop simply overwrites, last-write-wins,
    // same as every other PATCH route in this codebase.
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
    } else if (typeof raw === "string") {
      update[key] = raw.trim() || null;
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0 && body.assignee_ids === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  if (body.assignee_ids !== undefined) {
    if (!Array.isArray(body.assignee_ids)) {
      return NextResponse.json({ error: "assignee_ids must be an array" }, { status: 400 });
    }
    const { error: deleteError } = await supabase
      .from("office_task_assignees")
      .delete()
      .eq("task_id", id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    if (body.assignee_ids.length > 0) {
      const { error: insertError } = await supabase
        .from("office_task_assignees")
        .insert(body.assignee_ids.map((profileId) => ({ task_id: id, profile_id: profileId })));
      if (insertError) {
        const status = insertError.code === "23503" ? 400 : 500;
        return NextResponse.json({ error: insertError.message }, { status });
      }
    }
  }

  const { data: task, error } =
    Object.keys(update).length > 0
      ? await supabase
          .from("office_tasks")
          .update(update)
          .eq("id", id)
          .is("deleted_at", null)
          .select()
          .single()
      : await supabase.from("office_tasks").select("*").eq("id", id).is("deleted_at", null).single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ task });
}

/**
 * DELETE /api/office/tasks/[id]
 * Soft-delete (deleted_at) — parity with board_tasks and every other
 * soft-deleted table in this codebase.
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
    .from("office_tasks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
