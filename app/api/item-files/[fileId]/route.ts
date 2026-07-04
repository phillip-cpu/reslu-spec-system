import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * DELETE /api/item-files/[fileId]
 * Removes the Storage object and its item_files row.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: file } = await supabase
    .from("item_files")
    .select("storage_path")
    .eq("id", fileId)
    .single();

  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  await supabase.storage.from(ASSET_BUCKET).remove([file.storage_path]);

  const { error } = await supabase.from("item_files").delete().eq("id", fileId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
