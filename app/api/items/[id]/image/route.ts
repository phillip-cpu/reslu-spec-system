import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeFetch } from "@/lib/safe-fetch";
import { ASSET_BUCKET, extForMime } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/items/[id]/image
 * Stores an item's chosen image into Supabase Storage and returns its
 * public URL (BUILD-SPEC.md §6: "on selection, copy chosen image into
 * Supabase Storage; PDFs embed from Storage, never from supplier sites").
 *
 * Accepts either:
 *   - multipart/form-data with a `file` field, or
 *   - application/json { url } — fetched SSRF-safely and copied in.
 *
 * Returns { url }. The caller persists it via PATCH selected_image_url,
 * keeping a single write path for item mutations.
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

  let bytes: Buffer;
  let contentType: string | null;

  const reqType = request.headers.get("content-type") ?? "";
  try {
    if (reqType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      contentType = file.type || "application/octet-stream";
      bytes = Buffer.from(await file.arrayBuffer());
    } else {
      const body = await request.json().catch(() => ({}));
      if (!body?.url || typeof body.url !== "string") {
        return NextResponse.json({ error: "No url provided" }, { status: 400 });
      }
      const fetched = await safeFetch(body.url, { accept: "image/*" });
      bytes = fetched.bytes;
      contentType = fetched.contentType;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read image" },
      { status: 400 }
    );
  }

  if (!contentType || !contentType.startsWith("image/")) {
    return NextResponse.json(
      { error: "That file is not an image" },
      { status: 400 }
    );
  }
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }

  const ext = extForMime(contentType);
  const path = `items/${id}/image-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
