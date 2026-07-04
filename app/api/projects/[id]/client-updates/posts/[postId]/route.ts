import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/projects/[id]/client-updates/posts/[postId] — edit a
 * draft's title/body, OR publish/unpublish. Body:
 *   { title?, body_richtext?, publish?: boolean }
 * `publish: true` sets published_at = now() (only if currently null —
 * re-publishing an already-published post is a no-op on the timestamp,
 * so "Last update published N days ago" stays accurate to the FIRST
 * publish, not every subsequent edit). `publish: false` un-publishes
 * (sets published_at back to null), letting the team retract a post.
 *
 * DELETE — soft-delete.
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; postId: string }> }
) {
  const { id: projectId, postId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { title?: string; body_richtext?: string; publish?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.title === "string") updates.title = body.title.trim();
  if (typeof body.body_richtext === "string") updates.body_richtext = body.body_richtext.trim();

  if (body.publish === true) {
    const { data: existing } = await supabase
      .from("portal_updates")
      .select("published_at")
      .eq("id", postId)
      .eq("project_id", projectId)
      .single();
    if (existing && !existing.published_at) {
      updates.published_at = new Date().toISOString();
    }
  } else if (body.publish === false) {
    updates.published_at = null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No changes provided" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("portal_updates")
    .update(updates)
    .eq("id", postId)
    .eq("project_id", projectId)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json({ update: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; postId: string }> }
) {
  const { id: projectId, postId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("portal_updates")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", postId)
    .eq("project_id", projectId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
