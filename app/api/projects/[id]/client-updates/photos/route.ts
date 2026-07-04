import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, slugFilename } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/client-updates/photos — list progress photos
 * for the team client-area (newest first), signed URLs.
 *
 * POST /api/projects/[id]/client-updates/photos — multipart upload,
 * MULTIPLE files in one request: { files[], caption?, taken_at? }.
 * Team-authenticated (not admin-only — BUILD-SPEC.md "Team-side client
 * area": team access except variation sharing).
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

interface ProgressPhotoRow {
  id: string;
  project_id: string;
  storage_path: string;
  caption: string | null;
  taken_at: string | null;
  uploaded_by: string | null;
  created_at: string;
}

async function withUrl(supabase: SupabaseServerClient, row: ProgressPhotoRow) {
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  return { ...row, url: error ? null : data?.signedUrl ?? null };
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
    .from("progress_photos")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    photos: await Promise.all((photos as ProgressPhotoRow[]).map((p) => withUrl(supabase, p))),
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

  const created: (ProgressPhotoRow & { url: string | null })[] = [];
  const errors: string[] = [];

  // Sequential, like every other multi-file loop in this codebase
  // (lib/images.ts's PDF pre-pass) — simpler error accounting than
  // Promise.all, and upload volume here (a handful of site photos at a
  // time) doesn't need parallelism.
  for (const file of files) {
    const filename = file.name || "photo";
    const path = `projects/${projectId}/progress/${Date.now()}-${slugFilename(filename)}`;
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

    const { data: row, error: insertError } = await supabase
      .from("progress_photos")
      .insert({
        project_id: projectId,
        storage_path: path,
        caption,
        taken_at,
        uploaded_by: user.id,
      })
      .select()
      .single();

    if (insertError) {
      await supabase.storage.from(ASSET_BUCKET).remove([path]);
      errors.push(`${filename}: ${insertError.message}`);
      continue;
    }

    created.push(await withUrl(supabase, row as ProgressPhotoRow));
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join("; ") || "Upload failed" }, { status: 500 });
  }

  return NextResponse.json({ photos: created, errors }, { status: 201 });
}
