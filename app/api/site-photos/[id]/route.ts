import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/site-photos/[id] — edit caption, or toggle
 * published_to_portal / in_handover_pack. Body (any subset):
 *   { caption?, published_to_portal?, in_handover_pack?, taken_at? }
 *
 * Team-authenticated (not admin-only — same trust tier as progress
 * photos and project documents; nothing here is financial).
 *
 * Publish toggle here is the DIRECT per-photo publish control from the
 * Gallery grid (BUILD-SPEC.md "publish toggle per photo") — distinct
 * from the diary-publish path (PATCH .../client-updates/posts/[postId])
 * which marks LINKED photos published as a side effect of publishing
 * the whole diary entry. Both paths converge on the same
 * published_to_portal column, which is exactly the "one photo
 * pipeline, staged internally, curated out" the spec describes.
 *
 * DELETE — soft-delete (deleted_at), consistent with progress_photos'
 * softer sibling tables in this codebase where an audit trail matters
 * more than reclaiming space.
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

  let body: {
    caption?: string | null;
    published_to_portal?: boolean;
    in_handover_pack?: boolean;
    taken_at?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if ("caption" in body) updates.caption = body.caption?.trim() || null;
  if (typeof body.published_to_portal === "boolean") {
    updates.published_to_portal = body.published_to_portal;
  }
  if (typeof body.in_handover_pack === "boolean") {
    updates.in_handover_pack = body.in_handover_pack;
  }
  if (typeof body.taken_at === "string" && body.taken_at.trim()) {
    updates.taken_at = body.taken_at.trim();
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No changes provided" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("site_photos")
    .update(updates)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json({ photo: updated });
}

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

  const { error } = await supabase
    .from("site_photos")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
