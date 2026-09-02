import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadSowQualityReport } from "@/lib/sow-quality-server";

/** GET the current, read-only pre-issue quality assessment. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sowId: string }> }
) {
  const { id: projectId, sowId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: sow } = await supabase
    .from("sow_documents")
    .select("id")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!sow) return NextResponse.json({ error: "SOW not found" }, { status: 404 });

  try {
    const quality = await loadSowQualityReport(supabase, projectId, sowId);
    return NextResponse.json({ quality });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not assess this Scope of Works." },
      { status: 500 }
    );
  }
}
