import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchBoardGroupInput } from "@/types/phase-12a-b";

/**
 * PATCH /api/board-groups/[id]
 * body: { name?, sort? }. Response: { group }. Renaming a phase group
 * is the whole point of "editable in Settings" — every card's group
 * label follows automatically since cards only ever store
 * phase_group_id, never a denormalised name (same pattern as
 * board_columns).
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

  let body: PatchBoardGroupInput;
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

  const { data: group, error } = await supabase
    .from("board_groups")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  return NextResponse.json({ group });
}

/**
 * DELETE /api/board-groups/[id]
 * Hard delete (no soft-delete column, same reasoning as board_columns:
 * a removed phase group has no historical value worth retaining).
 * Cards in the group are NOT deleted — board_tasks.phase_group_id is
 * `on delete set null` (migration 020), so they simply become
 * "ungrouped" (still visible on their status column in Kanban view;
 * absent from the Grouped list view's table rows until re-assigned a
 * group). No "must be empty" guard here, unlike board_columns — losing
 * a phase label is a much lower-stakes action than losing a card
 * entirely, and the cards survive regardless.
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

  const { error } = await supabase.from("board_groups").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
