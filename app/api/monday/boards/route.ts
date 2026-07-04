import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listBoards } from "@/lib/monday/sync";

export const runtime = "nodejs";

/**
 * GET /api/monday/boards — boards for the project→board picker.
 * Returns { configured:false } when MONDAY_API_TOKEN isn't set, so the
 * UI can show a helpful hint instead of an error.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await listBoards();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        boards: [],
        error: err instanceof Error ? err.message : "Monday API error",
      },
      { status: 200 }
    );
  }
}
