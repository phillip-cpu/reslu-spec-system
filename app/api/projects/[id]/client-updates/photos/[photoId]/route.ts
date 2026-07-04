import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/projects/[id]/client-updates/photos/[photoId] — edit caption.
 * DELETE — soft-delete (deleted_at), matching project_files' pattern.
 * Team-authenticated.
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> }
) {
  const { id: projectId, photoId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { caption?: string | null; taken_at?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if ("caption" in body) updates.caption = body.caption?.trim() || null;
  if ("taken_at" in body) updates.taken_at = body.taken_at || null;

  const { data: updated, error } = await supabase
    .from("progress_photos")
    .update(updates)
    .eq("id", photoId)
    .eq("project_id", projectId)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json({ photo: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> }
) {
  const { id: projectId, photoId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("progress_photos")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", photoId)
    .eq("project_id", projectId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
