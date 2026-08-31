import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { validateUploadBytes } from "@/lib/file-sniff";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, slugFilename } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: packageId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can add quote attachments" }, { status: 403 });

  const { data: quotePackage } = await supabase.from("supplier_quote_packages").select("id,project_id,status").eq("id", packageId).is("deleted_at", null).maybeSingle();
  if (!quotePackage) return NextResponse.json({ error: "Quote package not found" }, { status: 404 });
  if (quotePackage.status !== "draft") return NextResponse.json({ error: "Attachments are frozen after a quote package is sent" }, { status: 409 });

  const form = await request.formData().catch(() => null);
  const files = form?.getAll("files").filter((value): value is File => value instanceof File) ?? [];
  const caption = typeof form?.get("caption") === "string" && String(form?.get("caption")).trim() ? String(form?.get("caption")).trim() : null;
  if (files.length === 0) return NextResponse.json({ error: "No files provided" }, { status: 400 });

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
    const filename = file.name || "attachment";
    const path = `projects/${quotePackage.project_id}/quote-packages/${packageId}/${Date.now()}-${crypto.randomUUID()}-${slugFilename(filename)}`;
    const { error: uploadError } = await supabase.storage.from(ASSET_BUCKET).upload(path, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
    if (uploadError) {
      errors.push(`${filename}: ${uploadError.message}`);
      continue;
    }
    const { data: row, error: insertError } = await supabase.from("supplier_quote_attachments").insert({
      package_id: packageId,
      kind: "request",
      storage_path: path,
      filename,
      mime: file.type || null,
      caption,
      byte_size: file.size,
      uploaded_by: info.userId,
    }).select().single();
    if (insertError || !row) {
      await supabase.storage.from(ASSET_BUCKET).remove([path]);
      errors.push(`${filename}: ${insertError?.message ?? "Could not save attachment"}`);
      continue;
    }
    const { data: signed } = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    created.push({ ...row, url: signed?.signedUrl ?? null });
  }
  if (created.length === 0) return NextResponse.json({ error: errors.join("; ") || "Upload failed" }, { status: 400 });
  return NextResponse.json({ attachments: created, errors }, { status: 201 });
}
