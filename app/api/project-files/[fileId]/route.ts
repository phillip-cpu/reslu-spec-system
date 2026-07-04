import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * DELETE /api/project-files/[fileId]
 * Soft-deletes (sets deleted_at) — unlike item_files (which hard-
 * deletes the Storage object + row), project_files keeps its revision
 * history: BUILD-SPEC.md "Project documents" calls for older revisions
 * to remain visible (muted, beneath the latest), so a delete here is
 * expected to be a genuine "no longer needed" action, not a routine
 * revision replacement — hence a reversible soft delete rather than
 * destroying the Storage object outright. The Storage object is left
 * in place (not removed) so an admin could still recover it directly
 * from Storage if a delete turns out to be a mistake; it simply drops
 * out of the GET listing (which filters deleted_at is null).
 *
 * Allowed: admin, or the original uploader (BUILD-SPEC.md "delete
 * (admin or uploader)") — everyone else gets 403.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: file, error: fetchError } = await supabase
    .from("project_files")
    .select("id, uploaded_by, deleted_at")
    .eq("id", fileId)
    .single();

  if (fetchError || !file || file.deleted_at) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const admin = await isAdmin(supabase);
  if (!admin && file.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "Only an admin or the uploader can remove this document" },
      { status: 403 }
    );
  }

  const { error } = await supabase
    .from("project_files")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", fileId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
