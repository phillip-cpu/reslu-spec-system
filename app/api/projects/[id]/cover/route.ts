import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, extForMime } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB cap, per BUILD-SPEC.md "Project cover image"

/**
 * Project cover images (Week 7).
 *
 * Bucket decision: client houses are private information (unlike item
 * product photos, which are already-public supplier catalogue images)
 * — stored in the PRIVATE `assets` bucket, same as item/project
 * documents and invoices, at `projects/{id}/cover.<ext>` (fixed
 * filename per project — `upsert: true` — so replacing the cover
 * doesn't accumulate orphaned objects and the storage_path never needs
 * to change on replace, only the timestamp query param the UI can bust
 * the cache with if desired). Served exclusively via signed URLs
 * minted server-side (GET below, and batched from the dashboard/list
 * routes) — never a permanent public link.
 *
 * POST /api/projects/[id]/cover — multipart { file } (image/*, 10MB cap).
 * Response: { cover_image_path, url } (the freshly-minted signed URL,
 * so the UI can show the new cover immediately without a second fetch).
 *
 * DELETE /api/projects/[id]/cover — removes the Storage object and
 * clears projects.cover_image_path.
 *
 * GET /api/projects/[id]/cover — { url: string | null }, a fresh signed
 * URL for the current cover (or null if none set) — used by the
 * project page header and any client component that needs to refresh
 * the URL after it expires.
 */
export async function POST(
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

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Expected form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "That file is not an image" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image is too large — 10MB max (got ${(file.size / 1024 / 1024).toFixed(1)}MB).` },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }

  const ext = extForMime(file.type);
  const path = `projects/${id}/cover.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: true });
  if (uploadError) {
    return NextResponse.json(
      { error: `Storage: ${uploadError.message}. If this mentions a missing bucket, run migration 009.` },
      { status: 500 }
    );
  }

  const { data: project, error: updateError } = await supabase
    .from("projects")
    .update({ cover_image_path: path })
    .eq("id", id)
    .select("cover_image_path")
    .single();
  if (updateError || !project) {
    return NextResponse.json(
      { error: updateError?.message ?? "Project not found" },
      { status: 500 }
    );
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  return NextResponse.json({
    cover_image_path: path,
    url: signError ? null : signed?.signedUrl ?? null,
  });
}

/** GET /api/projects/[id]/cover — a fresh signed URL for the current cover. */
export async function GET(
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

  const { data: project, error } = await supabase
    .from("projects")
    .select("cover_image_path")
    .eq("id", id)
    .single();
  if (error || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!project.cover_image_path) {
    return NextResponse.json({ url: null });
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(project.cover_image_path, SIGNED_URL_TTL_SECONDS);

  return NextResponse.json({ url: signError ? null : signed?.signedUrl ?? null });
}

/** DELETE /api/projects/[id]/cover — removes the image and clears the column. */
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

  const { data: project } = await supabase
    .from("projects")
    .select("cover_image_path")
    .eq("id", id)
    .single();

  if (project?.cover_image_path) {
    await supabase.storage.from(ASSET_BUCKET).remove([project.cover_image_path]);
  }

  const { error } = await supabase
    .from("projects")
    .update({ cover_image_path: null })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
