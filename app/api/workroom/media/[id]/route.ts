import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { data: media, error } = await supabase
    .from("agent_task_artifact_media")
    .select("preview_storage_path,preview_sha256,mime_type,byte_size")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!media) return NextResponse.json({ error: "Review image not found" }, { status: 404 });

  const etag = `"${media.preview_sha256}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  const { data: file, error: downloadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .download(media.preview_storage_path);
  if (downloadError || !file) return NextResponse.json({ error: "Review image is unavailable" }, { status: 404 });

  return new NextResponse(await file.arrayBuffer(), {
    headers: {
      "Content-Type": media.mime_type,
      "Content-Length": String(media.byte_size),
      "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
