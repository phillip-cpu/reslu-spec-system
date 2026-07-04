import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchBoardColumnInput } from "@/types";

/**
 * PATCH /api/board-columns/[id]
 * body: { name?, sort? }. Response: { column }. Renaming a column is
 * the whole point of "per-project editable columns" — every task
 * card's group label follows automatically since cards only ever
 * store column_id, never a denormalised column name.
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

  let body: PatchBoardColumnInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    update.name = body.name.trim();
  }
  if (body.sort !== undefined) {
    update.sort = Number(body.sort);
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: column, error } = await supabase
    .from("board_columns")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!column) {
    return NextResponse.json({ error: "Column not found" }, { status: 404 });
  }

  return NextResponse.json({ column });
}

/**
 * DELETE /api/board-columns/[id]
 * Hard delete — BUT only when the column is empty (BUILD-SPEC.md
 * detailed scope: "delete only when empty"), checked against
 * non-deleted tasks. board_tasks.column_id is `on delete cascade`, so
 * a column with tasks CAN technically be dropped at the DB layer, but
 * this route deliberately refuses (400) rather than silently
 * cascading away a team member's cards — the UI must move or delete
 * the cards first. No soft-delete column exists on board_columns (a
 * renamed-away, emptied column has no historical value worth
 * retaining, unlike items/cost_lines).
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

  const { count } = await supabase
    .from("board_tasks")
    .select("id", { count: "exact", head: true })
    .eq("column_id", id)
    .is("deleted_at", null);

  if (count && count > 0) {
    return NextResponse.json(
      { error: "This column still has cards — move or remove them first." },
      { status: 400 }
    );
  }

  const { error } = await supabase.from("board_columns").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
