import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchSafely, UnsafeUrlError } from "@/lib/scraper/guard";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import type { AttachFromUrlInput, ItemFile, ItemFileKind } from "@/types";

export const runtime = "nodejs";

const KINDS: ItemFileKind[] = ["spec_sheet", "install_manual", "other"];

// BUILD-SPEC.md "Scraper extension — document detection": "Same SSRF
// guards as the page scrape; size cap ~20MB per PDF."
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/items/[id]/files/from-url — { url, kind }
 *
 * Server-side "Attach" for a document detected during the product-page
 * scrape (items.scraped_documents — see lib/scraper/extract.ts). Runs
 * the same SSRF-hardened fetch (lib/scraper/guard.ts) as the page
 * scrape itself, with a larger byte cap appropriate for PDFs (20MB vs
 * the 5MB page-scrape cap), downloads the file into Supabase Storage,
 * and creates an item_files row — same shape as the existing multipart
 * upload route (app/api/items/[id]/files/route.ts), which this route
 * does not modify.
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

  const { data: item } = await supabase
    .from("items")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  let body: AttachFromUrlInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = body?.url?.trim();
  const kind = body?.kind;
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  if (!kind || !KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  let bytes: Buffer;
  let contentType: string | null;
  try {
    const result = await fetchSafely(url, {
      maxBytes: MAX_DOCUMENT_BYTES,
      accept: "application/pdf,application/octet-stream,*/*",
    });
    bytes = result.bytes;
    contentType = result.contentType;
  } catch (err) {
    const message =
      err instanceof UnsafeUrlError
        ? "That URL points to a disallowed address."
        : err instanceof Error
          ? err.message
          : "Could not download the document.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const filenameFromUrl = (() => {
    try {
      const path = new URL(url).pathname;
      return decodeURIComponent(path.split("/").pop() || "document.pdf");
    } catch {
      return "document.pdf";
    }
  })();
  const filename = slugFilename(filenameFromUrl) || "document.pdf";
  const path = `items/${id}/files/${Date.now()}-${filename}`;

  const { error: uploadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, bytes, {
      contentType: contentType || "application/pdf",
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
    // best-effort cleanup of the orphaned object, matching the existing
    // multipart upload route's behaviour.
    await supabase.storage.from(ASSET_BUCKET).remove([path]);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Prune this URL out of the staged scraped_documents list, if present —
  // it's now a real attached file, not just a detected candidate.
  const { data: current } = await supabase
    .from("items")
    .select("scraped_documents")
    .eq("id", id)
    .single();
  if (current && Array.isArray(current.scraped_documents)) {
    const pruned = (current.scraped_documents as { url: string }[]).filter(
      (d) => d.url !== url
    );
    if (pruned.length !== current.scraped_documents.length) {
      await supabase.from("items").update({ scraped_documents: pruned }).eq("id", id);
    }
  }

  const { data: publicUrl } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);

  return NextResponse.json(
    { file: { ...(row as unknown as ItemFile), url: publicUrl.publicUrl } },
    { status: 201 }
  );
}
