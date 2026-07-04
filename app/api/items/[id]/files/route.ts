import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import type { ItemFile, ItemFileKind } from "@/types";

export const runtime = "nodejs";

const KINDS: ItemFileKind[] = ["spec_sheet", "install_manual", "other"];

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function withUrl(supabase: SupabaseServerClient, file: ItemFile) {
  const { data } = supabase.storage
    .from(ASSET_BUCKET)
    .getPublicUrl(file.storage_path);
  return { ...file, url: data.publicUrl };
}

/** GET /api/items/[id]/files — list an item's documents with public URLs. */
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

  const { data: files, error } = await supabase
    .from("item_files")
    .select("*")
    .eq("item_id", id)
    .order("uploaded_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    files: (files as ItemFile[]).map((f) => withUrl(supabase, f)),
  });
}

/**
 * POST /api/items/[id]/files — multipart { file, kind }.
 * Uploads a spec sheet / install manual / other doc into Storage and
 * indexes it in item_files (BUILD-SPEC.md §5).
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
  const kind = String(form.get("kind") ?? "other") as ItemFileKind;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  const filename = file.name || "document";
  const path = `items/${id}/files/${Date.now()}-${slugFilename(filename)}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: row, error: insertError } = await supabase
    .from("item_files")
    .insert({
      item_id: id,
      kind,
      storage_path: path,
      filename,
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
    { file: withUrl(supabase, row as ItemFile) },
    { status: 201 }
  );
}
