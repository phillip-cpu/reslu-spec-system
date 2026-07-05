import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";

/**
 * GET /api/projects/[id]/client-updates/posts/[postId]/aria-draft
 *   Fetches everything Aria needs to draft the polished story: the
 *   staff's rough notes (current title/body_richtext), and the
 *   captions of any linked gallery photos (not the image bytes — Aria
 *   drafts prose from text, per BUILD-SPEC.md "Aria drafts the story
 *   via API"). Team-session-authenticated (Aria signs in as a normal
 *   team member, role admin — see docs/ARIA.md).
 *
 * POST /api/projects/[id]/client-updates/posts/[postId]/aria-draft
 *   Body: { title, body_richtext }. Submits Aria's polished copy back
 *   onto the SAME draft row: overwrites title/body_richtext, sets
 *   draft_source='aria', status='pending_approval'. Never touches
 *   published_at — publishing stays a separate, human, one-tap action
 *   (PATCH .../posts/[postId] with { publish: true }), per
 *   BUILD-SPEC.md's explicit "she drafts — never publishes" boundary
 *   (see docs/ARIA.md's Diary workflow section).
 *
 * Both routes 404 if the target isn't currently a 'draft' — Aria
 * cannot fetch or overwrite a draft that's already pending_approval or
 * published, which would either duplicate a chase-list entry or
 * silently rewrite a live client-facing entry.
 */

export async function GET(
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

  const { data: update } = await supabase
    .from("portal_updates")
    .select("id,title,body_richtext,status,draft_source")
    .eq("id", postId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();

  if (!update) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (update.status !== "draft") {
    return NextResponse.json(
      { error: `This entry is already '${update.status}' — nothing to draft.` },
      { status: 409 }
    );
  }

  const { data: links } = await supabase
    .from("portal_update_photos")
    .select("sort,site_photos(id,caption,storage_path,taken_at)")
    .eq("update_id", postId)
    .order("sort", { ascending: true });

  const photos = await Promise.all(
    (links ?? []).map(async (link) => {
      const photo = Array.isArray(link.site_photos) ? link.site_photos[0] : link.site_photos;
      if (!photo) return null;
      const { data: signed } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(photo.storage_path, SIGNED_URL_TTL_SECONDS);
      return {
        id: photo.id,
        caption: photo.caption,
        taken_at: photo.taken_at,
        url: signed?.signedUrl ?? null,
      };
    })
  );

  return NextResponse.json({
    update: {
      id: update.id,
      rough_notes: update.body_richtext,
      current_title: update.title,
    },
    photos: photos.filter((p): p is NonNullable<typeof p> => p !== null),
  });
}

export async function POST(
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

  let body: { title?: string; body_richtext?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const title = body.title?.trim();
  const content = body.body_richtext?.trim();
  if (!title || !content) {
    return NextResponse.json({ error: "title and body_richtext are required" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("portal_updates")
    .select("id,status")
    .eq("id", postId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (existing.status !== "draft") {
    return NextResponse.json(
      { error: `This entry is already '${existing.status}' — cannot submit a new draft over it.` },
      { status: 409 }
    );
  }

  const { data: updated, error } = await supabase
    .from("portal_updates")
    .update({
      title,
      body_richtext: content,
      draft_source: "aria",
      status: "pending_approval",
    })
    .eq("id", postId)
    .eq("project_id", projectId)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Could not save Aria's draft" }, { status: 500 });
  }

  return NextResponse.json({ update: updated });
}
