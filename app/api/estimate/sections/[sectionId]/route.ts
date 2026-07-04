import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

/**
 * PATCH /api/estimate/sections/[sectionId]
 * body: { name?: string, sort?: number } — rename/reorder a section.
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;
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

  const { data: section, error } = await supabase
    .from("cost_sections")
    .update(update)
    .eq("id", sectionId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!section) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  return NextResponse.json({ section });
}

/**
 * DELETE /api/estimate/sections/[sectionId]
 * Hard-deletes the section — cost_lines cascade (section_id references
 * cost_sections(id) on delete cascade, per 007_estimating.sql). Unlike
 * cost_lines (which soft-delete individually for undo-ability), whole
 * sections aren't soft-deleted: BUILD-SPEC.md's "add/remove/rename
 * sections and lines freely" treats section removal as a structural
 * edit to a still-in-progress estimate, not a financial-record deletion
 * needing an audit trail the way an individual costed line does.
 * Admin-only.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;
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

  const { error } = await supabase.from("cost_sections").delete().eq("id", sectionId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
