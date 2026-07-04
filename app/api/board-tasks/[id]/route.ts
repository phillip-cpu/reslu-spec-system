import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchBoardTaskInput } from "@/types";

const EDITABLE_FIELDS = new Set([
  "column_id",
  "title",
  "description",
  "assignee_id",
  "contact_id",
  "due_date",
  "sort",
]);

/**
 * PATCH /api/board-tasks/[id]
 * body: PatchBoardTaskInput (partial) — used for both field edits
 * (title/description/assignee/contact/due_date) AND drag-drop moves
 * (column_id + sort together). Response: { task }. When `column_id` is
 * supplied, it's validated against the task's own project (a card can
 * never be dragged into another project's column via a forged id).
 * Aria-relevant (Aria operates boards).
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

  let body: PatchBoardTaskInput;
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
    } else if (typeof raw === "string") {
      update[key] = raw.trim() || null;
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: task, error } = await supabase
    .from("board_tasks")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ task });
}

/**
 * DELETE /api/board-tasks/[id]
 * Soft-delete (deleted_at) — parity with items/cost_lines/variations.
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

  return NextResponse.json({ ok: true });
}
