import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, slugFilename } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/site-photos — list the internal staging
 * gallery for a project (newest-taken first), signed URLs. Team-
 * authenticated. Optional ?since= (ISO date) to page/limit for large
 * galleries — omitted here (Phase 1 scope: return everything,
 * newest-first; the Gallery UI groups client-side by taken_at date).
 *
 * POST /api/projects/[id]/site-photos — multipart upload, MULTIPLE
 * files in one request: { files[], caption?, taken_at? }. Mirrors
 * app/api/projects/[id]/client-updates/photos/route.ts's existing
 * progress_photos upload shape exactly, writing to site_photos instead
 * (BUILD-SPEC.md §"Phase 11 addition — site photo gallery": internal
 * staging gallery, private bucket, signed URLs). Client-side image
 * compression (canvas, max 2000px) happens in the browser before this
 * route ever sees the bytes — see components/gallery/GalleryUploader.tsx
 * — this route does not re-compress; it trusts the upload it's given
 * the same way the existing progress-photos route does.
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

interface SitePhotoRow {
  id: string;
  project_id: string;
  storage_path: string;
  caption: string | null;
  taken_at: string;
  uploaded_by: string | null;
  published_to_portal: boolean;
  in_handover_pack: boolean;
  created_at: string;
}

async function withUrl(supabase: SupabaseServerClient, row: SitePhotoRow) {
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  return { ...row, url: error ? null : (data?.signedUrl ?? null) };
}

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

  const { data: photos, error } = await supabase
    .from("site_photos")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("taken_at", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    photos: await Promise.all((photos as SitePhotoRow[]).map((p) => withUrl(supabase, p))),
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

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Expected form data" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const captionRaw = form.get("caption");
  const caption = typeof captionRaw === "string" && captionRaw.trim() ? captionRaw.trim() : null;
  const takenAtRaw = form.get("taken_at");
  const taken_at = typeof takenAtRaw === "string" && takenAtRaw.trim() ? takenAtRaw.trim() : null;

  const created: (SitePhotoRow & { url: string | null })[] = [];
  const errors: string[] = [];

  // Sequential, same pattern as the existing progress_photos upload
  // loop (simpler error accounting than Promise.all; on-site upload
  // volume is a handful of photos at a time).
  for (const file of files) {
    const filename = file.name || "photo";
    const path = `projects/${projectId}/site-photos/${Date.now()}-${slugFilename(filename)}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from(ASSET_BUCKET)
      .upload(path, bytes, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (uploadError) {
      errors.push(`${filename}: ${uploadError.message}`);
      continue;
    }

    const insertRow: Record<string, unknown> = {
      project_id: projectId,
      storage_path: path,
      caption,
      uploaded_by: user.id,
    };
    if (taken_at) insertRow.taken_at = taken_at;

    const { data: row, error: insertError } = await supabase
      .from("site_photos")
      .insert(insertRow)
      .select()
      .single();

    if (insertError) {
      await supabase.storage.from(ASSET_BUCKET).remove([path]);
      errors.push(`${filename}: ${insertError.message}`);
      continue;
    }

    created.push(await withUrl(supabase, row as SitePhotoRow));
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join("; ") || "Upload failed" }, { status: 500 });
  }

  return NextResponse.json({ photos: created, errors }, { status: 201 });
}
