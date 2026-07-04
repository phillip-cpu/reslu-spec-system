import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, slugFilename } from "@/lib/storage";
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

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Expected form data" }, { status: 400 });
  }
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "other") as ProjectFileKind;
  const revisionLabelRaw = form.get("revision_label");
  const revision_label =
    typeof revisionLabelRaw === "string" && revisionLabelRaw.trim() !== ""
      ? revisionLabelRaw.trim()
      : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  const filename = file.name || "document";
  const path = `projects/${projectId}/files/${Date.now()}-${slugFilename(filename)}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadError) {
    return NextResponse.json(
      { error: `Storage: ${uploadError.message}. If this mentions a missing bucket, run migration 009.` },
      { status: 500 }
    );
  }

  const { data: row, error: insertError } = await supabase
    .from("project_files")
    .insert({
      project_id: projectId,
      kind,
      storage_path: path,
      filename,
      revision_label,
      uploaded_by: user.id,
    })
    .select()
    .single();

  if (insertError) {
    // best-effort cleanup of the orphaned object
    await supabase.storage.from(ASSET_BUCKET).remove([path]);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(
    { file: await withUrl(supabase, row as ProjectFile) },
    { status: 201 }
  );
}
