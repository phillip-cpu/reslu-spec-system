import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_ARCHIVED_GROUP_NAME } from "@/types/phase-13";
import type { PatchOfficeGroupInput } from "@/types/phase-13";

/**
 * PATCH /api/office/groups/[id]
 * body: { name?, sort? }. Response: { group }. The Archived group is
 * unrenameable (BUILD-SPEC.md §"13 Office" point 2's "Archived group
 * undeletable/unrenameable") — any `name` change targeting it is
 * rejected; `sort` changes are still allowed (re-ordering Archived
 * relative to other groups is harmless and not what "unrenameable"
 * guards against).
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
    .from("office_groups")
    .select("id,name")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  let body: PatchOfficeGroupInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.name !== undefined && existing.name === OFFICE_ARCHIVED_GROUP_NAME) {
    return NextResponse.json({ error: "The Archived group cannot be renamed." }, { status: 409 });
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
    .from("office_groups")
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
 * DELETE /api/office/groups/[id]
 * Soft-delete (deleted_at) — unlike board_groups (hard delete), Office
 * department groups are few, named, and meaningful long-term (Marketing/
 * Website/etc. rather than a per-project scratch phase label), so
 * soft-delete gives a recovery path if one is removed by mistake. The
 * Archived group is undeletable (BUILD-SPEC.md §"13 Office" point 2)
 * — rejected outright. A group with active (non-deleted) tasks is also
 * refused, same "must be empty" guard as board_columns, since
 * office_tasks.group_id has no ON DELETE SET NULL fallback the way
 * board_tasks.phase_group_id does (every task always belongs to a real
 * department, never "ungrouped").
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

  const { data: existing } = await supabase
    .from("office_groups")
    .select("id,name")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  if (existing.name === OFFICE_ARCHIVED_GROUP_NAME) {
    return NextResponse.json({ error: "The Archived group cannot be deleted." }, { status: 409 });
  }

  const { count } = await supabase
    .from("office_tasks")
    .select("id", { count: "exact", head: true })
    .eq("group_id", id)
    .is("deleted_at", null);

  if (count && count > 0) {
    return NextResponse.json(
      { error: "This group still has cards — move or remove them first." },
      { status: 409 }
    );
  }

  const { error } = await supabase
    .from("office_groups")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
