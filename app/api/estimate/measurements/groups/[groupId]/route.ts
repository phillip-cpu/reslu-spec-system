import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

/**
 * PATCH /api/estimate/measurements/groups/[groupId]
 * body: { name?: string, sort?: number }. Admin-only, per
 * BUILD-SPEC.md §Financial visibility.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const { groupId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  if (typeof body?.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (body?.sort !== undefined && Number.isFinite(Number(body.sort))) {
    update.sort = Number(body.sort);
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: group, error } = await supabase
    .from("measurement_groups")
    .update(update)
    .eq("id", groupId)
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
 * DELETE /api/estimate/measurements/groups/[groupId]
 * Hard-deletes the group — measurements cascade (group_id references
 * measurement_groups(id) on delete cascade). Measurements are
 * non-financial working notes (areas/dimensions), not costed records,
 * so no soft-delete is needed here — consistent with how cost_sections
 * (a structural container, not itself a costed line) is also
 * hard-deleted. Admin-only.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const { groupId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  const { error } = await supabase.from("measurement_groups").delete().eq("id", groupId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
