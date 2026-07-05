import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";

/**
 * GET /api/projects/[id]/client-updates/posts — list ALL updates
 * (drafts + published) for the team client-area's draft list. Team-
 * authenticated. (The portal's own read of PUBLISHED-only updates is
 * inline in app/portal/[token]/page.tsx, service-role, token-gated —
 * not this route, which requires a session and has no reason to be
 * reachable without one.)
 *
 * POST /api/projects/[id]/client-updates/posts — create a draft
 * (published_at stays null until PATCH .../publish). Body: { title,
 * body_richtext, photo_ids? }.
 *
 * Phase 11B diary workflow (BUILD-SPEC.md §"Diary" / §"mobile pass"):
 * the phone-first composer in the client area starts a draft with a
 * title placeholder and empty rough-notes body, so title/body_richtext
 * are allowed to be blank here (unlike the original Week 8B "Updates"
 * panel, which required both) — the Gallery's "Add to diary draft"
 * action also creates a bare draft with photos attached and nothing
 * written yet. `photo_ids`, if provided, links the given site_photos
 * rows via portal_update_photos (BUILD-SPEC.md "Diary composer ...
 * picks its 1-2 images FROM this gallery"). Ownership of each photo id
 * is verified against this project before linking.
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: updates, error } = await supabase
    .from("portal_updates")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Attach linked gallery photos (signed URLs) so the client-area Diary
  // panel can render thumbnails on drafts/pending-approval cards without
  // a second round-trip per update (BUILD-SPEC.md "Diary composer ...
  // picks its 1-2 images FROM this gallery").
  const updateIds = (updates ?? []).map((u) => u.id);
  const photosByUpdate = new Map<string, { id: string; url: string | null; caption: string | null }[]>();
  if (updateIds.length > 0) {
    const { data: links } = await supabase
      .from("portal_update_photos")
      .select("update_id,sort,site_photos(id,storage_path,caption)")
      .in("update_id", updateIds)
      .order("sort", { ascending: true });

    for (const link of links ?? []) {
      const photo = Array.isArray(link.site_photos) ? link.site_photos[0] : link.site_photos;
      if (!photo) continue;
      const { data: signed } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(photo.storage_path, SIGNED_URL_TTL_SECONDS);
      const list = photosByUpdate.get(link.update_id) ?? [];
      list.push({ id: photo.id, url: signed?.signedUrl ?? null, caption: photo.caption });
      photosByUpdate.set(link.update_id, list);
    }
  }

  return NextResponse.json({
    updates: (updates ?? []).map((u) => ({ ...u, photos: photosByUpdate.get(u.id) ?? [] })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { title?: string; body_richtext?: string; photo_ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const title = body.title?.trim() || "Site update";
  const content = body.body_richtext?.trim() ?? "";
  const photoIds = Array.isArray(body.photo_ids) ? body.photo_ids.filter((id) => typeof id === "string") : [];

  const { data: row, error } = await supabase
    .from("portal_updates")
    .insert({
      project_id: projectId,
      title,
      body_richtext: content,
      author_id: user.id,
      draft_source: "manual",
      status: "draft",
      // published_at stays null — draft until explicitly published.
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (photoIds.length > 0) {
    // Verify each photo belongs to THIS project before linking —
    // same ownership discipline as every other cross-table write in
    // this codebase (portal token checks, signature request subject
    // checks, etc.).
    const { data: ownedPhotos } = await supabase
      .from("site_photos")
      .select("id")
      .eq("project_id", projectId)
      .in("id", photoIds)
      .is("deleted_at", null);

    const validIds = (ownedPhotos ?? []).map((p) => p.id);
    if (validIds.length > 0) {
      await supabase.from("portal_update_photos").insert(
        validIds.map((site_photo_id, i) => ({
          update_id: row.id,
          site_photo_id,
          sort: i,
        }))
      );
    }
  }

  return NextResponse.json({ update: row }, { status: 201 });
}
