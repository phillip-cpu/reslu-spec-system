import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import type { ProjectFile, ProjectFileKind } from "@/types";

export const runtime = "nodejs";

const KINDS: ProjectFileKind[] = ["plans", "council", "engineering", "scope_of_works", "other"];

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * `assets` is a PRIVATE bucket (migration 009_assets_bucket.sql) — mint
 * a short-TTL signed URL per request rather than getPublicUrl(), which
 * would 403 against a private bucket. A signing failure drops that
 * file's url to null rather than failing the whole list.
 */
async function withUrl(supabase: SupabaseServerClient, file: ProjectFile) {
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
  return { ...file, url: error ? null : data?.signedUrl ?? null };
}

/**
 * GET /api/projects/[id]/files — list a project's documents (all five
 * kinds, non-deleted) with signed URLs. Team-visible (not admin-gated
 * — BUILD-SPEC.md "Project documents": "documents aren't financial"),
 * same trust model as GET /api/items/[id]/files.
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

  const { data: files, error } = await supabase
    .from("project_files")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    files: await Promise.all((files as ProjectFile[]).map((f) => withUrl(supabase, f))),
  });
}

/**
 * POST /api/projects/[id]/files — multipart { file, kind, revision_label? }.
 * Uploads a document into the same `assets` bucket item_files already
 * uses (project-files/ prefix instead of items/), indexes it in
 * project_files. Follows app/api/items/[id]/files/route.ts's POST
 * exactly, plus the optional revision_label field (BUILD-SPEC.md
 * "Project documents": "Revision label is first-class").
 */
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

  // Metadata-only: the file was already uploaded straight to Storage via a
  // signed upload URL (POST .../files/upload-url), bypassing the ~4.5 MB
  // Vercel body limit. This just records the row for the storage object.
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const storage_path = typeof body.storage_path === "string" ? body.storage_path : "";
  const filename =
    typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "document";
  const kind = String(body.kind ?? "other") as ProjectFileKind;
  const revision_label =
    typeof body.revision_label === "string" && body.revision_label.trim() !== ""
      ? body.revision_label.trim()
      : null;

  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }
  // The path must be one this project owns — it was minted by the upload-url
  // route for exactly this prefix, so a forged cross-project path is rejected.
  if (!storage_path.startsWith(`projects/${projectId}/files/`)) {
    return NextResponse.json({ error: "Invalid storage path" }, { status: 400 });
  }

  const { data: row, error: insertError } = await supabase
    .from("project_files")
    .insert({
      project_id: projectId,
      kind,
      storage_path,
      filename,
      revision_label,
      uploaded_by: user.id,
    })
    .select()
    .single();

  if (insertError) {
    // best-effort cleanup of the orphaned object
    await supabase.storage.from(ASSET_BUCKET).remove([storage_path]);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(
    { file: await withUrl(supabase, row as ProjectFile) },
    { status: 201 }
  );
}
