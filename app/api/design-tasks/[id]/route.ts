import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchDesignTaskInput } from "@/types/phase-12b";

// migration 041 — "due_time" added to parity with due_date (see
// PatchDesignTaskInput's own doc comment, types/phase-12b.ts).
const EDITABLE_FIELDS = new Set(["title", "description", "due_date", "due_time", "sort"]);

/**
 * PATCH /api/design-tasks/[id]
 * body: PatchDesignTaskInput (partial). Response: { task } (plain
 * design_tasks row — the caller already holds assignees client-side and
 * merges this patch in, same pattern as PATCH /api/office/tasks/[id] /
 * PATCH /api/board-tasks/[id]).
 *
 * `complete: true` / `complete: false` are explicit boolean-intent
 * actions (not a raw `completed_at` write) — true stamps completed_at,
 * false clears it. No archive-move side effect here (unlike Office
 * board's complete-and-archive) — a design task's phase never changes
 * on completion, it just ticks.
 *
 * Team access (not admin-gated).
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
    .from("design_tasks")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: PatchDesignTaskInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (body.complete !== undefined) {
    update.completed_at = body.complete ? new Date().toISOString() : null;
    // Keep due_date as completion history. My Work filters by completed_at
    // and uses the retained date to place the row in its Completed area.
  }

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
      .from("design_task_assignees")
      .delete()
      .eq("task_id", id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    if (body.assignee_ids.length > 0) {
      const { error: insertError } = await supabase
        .from("design_task_assignees")
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
          .from("design_tasks")
          .update(update)
          .eq("id", id)
          .is("deleted_at", null)
          .select()
          .single()
      : await supabase.from("design_tasks").select("*").eq("id", id).is("deleted_at", null).single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ task });
}

/**
 * DELETE /api/design-tasks/[id]
 * Soft-delete (deleted_at) — parity with board_tasks/office_tasks.
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
    .from("design_tasks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
