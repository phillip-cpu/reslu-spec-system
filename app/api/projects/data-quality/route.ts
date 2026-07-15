import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { loadProjectDataQuality } from "@/lib/project-data-quality-server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Company-wide, admin-only Project Health feed for Aria's review tools.
 * It is deliberately read-only and returns the same reports the project
 * panel uses; no record can be corrected through this route.
 */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access company-wide project health" },
      { status: 403 }
    );
  }

  const { data: projects, error } = await supabase
    .from("projects")
    .select("id,name,alias,status")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const settled = await Promise.allSettled(
    (projects ?? []).map(async (project) => ({
      project,
      report: await loadProjectDataQuality(supabase, project.id),
    }))
  );

  const errors: { project_id: string; message: string }[] = [];
  const reports = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    const project = (projects ?? [])[index];
    errors.push({
      project_id: project?.id ?? "unknown",
      message: result.reason instanceof Error ? result.reason.message : "Unknown error",
    });
    return [];
  });

  return NextResponse.json({
    summary: {
      projects: reports.length,
      critical: reports.reduce((sum, row) => sum + row.report.summary.critical, 0),
      warning: reports.reduce((sum, row) => sum + row.report.summary.warning, 0),
      affected_records: reports.reduce(
        (sum, row) => sum + row.report.summary.affected_records,
        0
      ),
    },
    projects: reports.map(({ project, report }) => ({ ...project, ...report })),
    errors,
    generated_at: new Date().toISOString(),
  });
}
