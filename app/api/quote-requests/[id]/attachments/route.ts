import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { validateUploadBytes } from "@/lib/file-sniff";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Attach a quote received by email, download or paper scan to its supplier response. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: requestId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can attach quote documents" }, { status: 403 });

  const { data: quoteRequest } = await supabase
    .from("supplier_quote_requests")
    .select("id,package_id")
    .eq("id", requestId)
    .maybeSingle();
  if (!quoteRequest) return NextResponse.json({ error: "Quote request not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const files = form?.getAll("files").filter((value): value is File => value instanceof File && value.size > 0) ?? [];
  if (files.length === 0) return NextResponse.json({ error: "Choose at least one quote document" }, { status: 400 });

  const created = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}: file is larger than 20 MB`);
      continue;
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const validation = validateUploadBytes(bytes, file.type || "");
    if (!validation.ok) {
      errors.push(`${file.name}: ${validation.error}`);
      continue;
    }
    const filename = file.name || "quote-document";
    const storagePath = `quote-responses/${requestId}/${Date.now()}-${crypto.randomUUID()}-${slugFilename(filename)}`;
    const { error: uploadError } = await supabase.storage
      .from(ASSET_BUCKET)
      .upload(storagePath, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
    if (uploadError) {
      errors.push(`${filename}: ${uploadError.message}`);
      continue;
    }
    const { data: row, error: insertError } = await supabase
      .from("supplier_quote_attachments")
      .insert({
        package_id: quoteRequest.package_id,
        request_id: quoteRequest.id,
        kind: "response",
        storage_path: storagePath,
        filename,
        mime: file.type || null,
        byte_size: file.size,
        uploaded_by: info.userId,
      })
      .select("id,filename")
      .single();
    if (insertError || !row) {
      await supabase.storage.from(ASSET_BUCKET).remove([storagePath]);
      errors.push(`${filename}: ${insertError?.message ?? "Could not save attachment"}`);
      continue;
    }
    created.push(row);
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join("; ") || "Could not attach quote documents" }, { status: 400 });
  }
  return NextResponse.json({ attachments: created, errors }, { status: 201 });
}
