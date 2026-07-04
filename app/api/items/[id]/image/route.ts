import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeFetch } from "@/lib/safe-fetch";
import { extForMime } from "@/lib/storage";
import { PDF_IMAGE_BUCKET } from "@/lib/images";

export const runtime = "nodejs";

/**
 * POST /api/items/[id]/image
 * Stores an item's chosen image into Supabase Storage and returns its
 * public URL (BUILD-SPEC.md §6: "on selection, copy chosen image into
 * Supabase Storage; PDFs embed from Storage, never from supplier sites").
 *
 * Bucket decision (Week 7 / migration 009_assets_bucket.sql): this
 * route used to upload into the `assets` bucket and call
 * getPublicUrl() on it — a bug, since `assets` was never created by
 * any migration AND (once created) is private, so getPublicUrl() would
 * mint a URL that 403s. Cover images are a durable value persisted
 * onto items.selected_image_url and reused indefinitely (spec
 * register thumbnail, client portal, builder PDF), so they belong in
 * the PUBLIC `item-images` bucket instead — the same bucket the PDF
 * pre-pass (lib/images.ts ensureStoredImage()) already re-hosts
 * external images into for exactly this reason. Using one bucket for
 * both write paths means selected_image_url always points at the same
 * public host regardless of which path wrote it.
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
    .from(PDF_IMAGE_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });

  if (uploadError) {
    return NextResponse.json(
      { error: `Storage: ${uploadError.message}. If this mentions a missing bucket, run migration 009.` },
      { status: 500 }
    );
  }

  const { data } = supabase.storage.from(PDF_IMAGE_BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
