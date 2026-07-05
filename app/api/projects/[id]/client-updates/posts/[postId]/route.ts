import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { notifyClient } from "@/lib/notify-client";

/**
 * PATCH /api/projects/[id]/client-updates/posts/[postId] — edit a
 * draft's title/body, OR publish/unpublish. Body:
 *   { title?, body_richtext?, publish?: boolean }
 * `publish: true` sets published_at = now() (only if currently null —
 * re-publishing an already-published post is a no-op on the timestamp,
 * so "Last update published N days ago" stays accurate to the FIRST
 * publish, not every subsequent edit) AND status='published' (Phase
 * 11B diary workflow — see migration 016's PART 3). `publish: false`
 * un-publishes (sets published_at back to null, status back to
 * 'draft'), letting the team retract a post.
 *
 * On a genuine first publish, also: marks any linked
 * portal_update_photos' site_photos as published_to_portal (BUILD-SPEC
 * "publishing the diary entry marks those photos published") and fires
 * a client email notification (BUILD-SPEC §"Phase 11 additions —
 * confirmed by Phillip" point 1) — both best-effort, never fail the
 * publish itself.
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

  let isFirstPublish = false;
  if (body.publish === true) {
    const { data: existing } = await supabase
      .from("portal_updates")
      .select("published_at")
      .eq("id", postId)
      .eq("project_id", projectId)
      .single();
    if (existing && !existing.published_at) {
      updates.published_at = new Date().toISOString();
      isFirstPublish = true;
    }
    updates.status = "published";
  } else if (body.publish === false) {
    updates.published_at = null;
    updates.status = "draft";
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

  if (isFirstPublish) {
    // Mark linked gallery photos published (best-effort — a failure
    // here must not undo the publish that already committed above).
    try {
      const { data: links } = await supabase
        .from("portal_update_photos")
        .select("site_photo_id")
        .eq("update_id", postId);
      const photoIds = (links ?? []).map((l) => l.site_photo_id);
      if (photoIds.length > 0) {
        await supabase
          .from("site_photos")
          .update({ published_to_portal: true })
          .in("id", photoIds);
      }
    } catch {
      // best-effort only
    }

    void notifyClient(supabase, projectId, {
      trigger: "diary_published",
      label: updated.title,
      section: "diary",
    });
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
