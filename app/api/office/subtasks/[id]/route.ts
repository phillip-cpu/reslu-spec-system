import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchOfficeSubtaskInput } from "@/types/phase-13";

/**
 * PATCH /api/office/subtasks/[id]
 * body: { title?, done?, sort? }. Response: { subtask }. Ticking a
 * subtask ('done' toggle) is the primary action driving the '2/5'
 * progress chip on the parent task row.
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

  let body: PatchOfficeSubtaskInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.title !== undefined) {
    if (!body.title.trim()) {
      return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
    }
    update.title = body.title.trim();
  }
  if (body.done !== undefined) {
    update.done = !!body.done;
  }
  if (body.sort !== undefined) {
    const n = Number(body.sort);
    if (!Number.isFinite(n)) {
      return NextResponse.json({ error: "sort must be a number" }, { status: 400 });
    }
    update.sort = n;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: subtask, error } = await supabase
    .from("office_subtasks")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!subtask) {
    return NextResponse.json({ error: "Subtask not found" }, { status: 404 });
  }

  return NextResponse.json({ subtask });
}

/**
 * DELETE /api/office/subtasks/[id]
 * Hard delete — no soft-delete column on office_subtasks (mirrors
 * board_groups' own "no historical value worth retaining" reasoning;
 * a removed tick-list step has nothing worth keeping once gone).
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

  const { error } = await supabase.from("office_subtasks").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
