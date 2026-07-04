import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/projects/[id]/files/upload-url
 * body: { filename }
 *
 * Mints a short-lived signed upload URL so the browser can PUT the file
 * DIRECTLY to Supabase Storage — bypassing the ~4.5 MB Vercel request-body
 * limit that made large documents (architectural plans etc.) fail when
 * they were streamed through the app. The client then records the file's
 * metadata via POST /api/projects/[id]/files. The returned `path` is the
 * canonical storage key both the direct upload and the metadata insert use.
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
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const filename =
    body && typeof body.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "document";

  const path = `projects/${projectId}/files/${Date.now()}-${slugFilename(filename)}`;

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
