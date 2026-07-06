import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/contacts/[id]/documents/upload-url
 * body: { filename }
 *
 * Mints a short-lived signed upload URL so the browser can PUT a trade
 * insurance/licence document DIRECTLY to Supabase Storage — same
 * two-step pattern as POST /api/projects/[id]/files/upload-url
 * (bypasses the ~4.5 MB Vercel request-body limit). The client then
 * records the file's metadata via POST /api/contacts/[id]/documents.
 * The returned `path` is the canonical storage key both the direct
 * upload and the metadata insert use — prefixed
 * contacts/{id}/documents/ so POST .../documents can validate the path
 * actually belongs to this contact before indexing it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contactId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .is("deleted_at", null)
    .single();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const filename =
    body && typeof body.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "document";

  const path = `contacts/${contactId}/documents/${Date.now()}-${slugFilename(filename)}`;

  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUploadUrl(path);
  if (error) {
    return NextResponse.json(
      { error: `${error.message}. If this mentions a missing bucket, run migration 009.` },
      { status: 500 }
    );
  }

  return NextResponse.json({ path: data.path, token: data.token });
}
