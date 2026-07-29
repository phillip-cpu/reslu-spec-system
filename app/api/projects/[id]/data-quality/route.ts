import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import {
  applyProjectDataQualityDismissals,
  compactProjectDataQuality,
} from "@/lib/project-data-quality";
import { loadProjectDataQuality } from "@/lib/project-data-quality-server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/data-quality
 *
 * Admin-only, read-only project diagnostics. Pricing and procurement
 * columns never leave this route except as compact coverage totals and
 * actionable issue counts. Nothing here mutates a project, item,
 * booking or board task.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);

  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access project data quality" },
      { status: 403 }
    );
  }

  try {
    const [report, dismissalsResult] = await Promise.all([
      loadProjectDataQuality(supabase, projectId),
      supabase
        .from("project_data_quality_dismissals")
        .select("issue_code,issue_fingerprint")
        .eq("project_id", projectId),
    ]);
    if (dismissalsResult.error) throw new Error(dismissalsResult.error.message);
    const dismissedFingerprints = new Map(
      (dismissalsResult.data ?? []).map((row) => [
        row.issue_code,
        row.issue_fingerprint,
      ])
    );
    const visibleReport = applyProjectDataQualityDismissals(
      report,
      dismissedFingerprints
    );
    const concise = new URL(request.url).searchParams.get("response_format") === "concise";
    return NextResponse.json(
      concise ? compactProjectDataQuality(visibleReport) : visibleReport
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load project health" },
      { status: 500 }
    );
  }
}
