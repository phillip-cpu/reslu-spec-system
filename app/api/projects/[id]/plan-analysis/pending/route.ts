import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import type { ProjectFile } from "@/types";
import type { PendingPlanAnalysisResponse } from "@/types/phase-12a-a";

/**
 * GET /api/projects/[id]/plan-analysis/pending
 * BUILD-SPEC.md "Aria plan analysis": "MCP/API: GET pending-analysis
 * plan files (signed URLs)." Returns every project_files row of kind
 * 'plans' that has NO plan_analyses row referencing it yet (file_id is
 * a one-to-many-eligible FK — a file can in principle be analysed more
 * than once, e.g. a re-analysis after a revision note; "pending" here
 * means "never analysed at all", the common queue-draining case Aria's
 * automation polls). Team access (not financial) — mirrors
 * GET /api/projects/[id]/files's trust model.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: planFiles, error: filesError }, { data: analysedRows, error: analysedError }] =
    await Promise.all([
      supabase
        .from("project_files")
        .select("*")
        .eq("project_id", projectId)
        .eq("kind", "plans")
        .is("deleted_at", null)
        .order("uploaded_at", { ascending: false }),
      supabase.from("plan_analyses").select("file_id").eq("project_id", projectId),
    ]);

  if (filesError) {
    return NextResponse.json({ error: filesError.message }, { status: 500 });
  }
  if (analysedError) {
    return NextResponse.json({ error: analysedError.message }, { status: 500 });
  }

  const analysedFileIds = new Set((analysedRows ?? []).map((r) => r.file_id as string));
  const pending = ((planFiles ?? []) as ProjectFile[]).filter((f) => !analysedFileIds.has(f.id));

  const withUrls = await Promise.all(
    pending.map(async (f) => {
      const { data, error } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(f.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...f, url: error ? null : data?.signedUrl ?? null };
    })
  );

  const payload: PendingPlanAnalysisResponse = { files: withUrls };
  return NextResponse.json(payload);
}
