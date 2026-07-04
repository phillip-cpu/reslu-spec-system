import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/projects/[id]/client-updates/files/[fileId]/share
 * Body: { share_to_portal: boolean }
 *
 * Toggles a project_files row's portal visibility (BUILD-SPEC.md "Week
 * 8 — Client portal expansion": "Plans (shared revisions from project
 * documents — per-file 'share to portal' toggle") and "Team-side client
 * area": "contract flow ... status chips". Team-authenticated, NOT
 * admin-only — documents aren't financial (same gating as the rest of
 * the Documents feature, migration 008's comment).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: projectId, fileId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { share_to_portal?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.share_to_portal !== "boolean") {
    return NextResponse.json({ error: "share_to_portal (boolean) is required" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("project_files")
    .update({ share_to_portal: body.share_to_portal })
    .eq("id", fileId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json({ file: updated });
}
