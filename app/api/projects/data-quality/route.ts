import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { compactProjectDataQuality } from "@/lib/project-data-quality";
import { loadProjectDataQuality } from "@/lib/project-data-quality-server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 25;

function integerParam(value: string | null, fallback: number, maximum?: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return maximum ? Math.min(parsed, maximum) : parsed;
}

/**
 * Company-wide, admin-only Project Health feed for Aria's review tools.
 * It is deliberately read-only and returns the same reports the project
 * panel uses; no record can be corrected through this route.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access company-wide project health" },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const responseFormat =
    url.searchParams.get("response_format") === "concise" ? "concise" : "detailed";
  const offset = integerParam(url.searchParams.get("offset"), 0);
  const limit = Math.max(
    1,
    integerParam(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  );

  const { data: projects, error, count } = await supabase
    .from("projects")
    .select("id,name,alias,status", { count: "exact" })
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name")
    .range(offset, offset + limit - 1);
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
    projects: reports.map(({ project, report }) => ({
      ...project,
      ...(responseFormat === "concise" ? compactProjectDataQuality(report) : report),
    })),
    errors,
    pagination: {
      offset,
      limit,
      total: count ?? reports.length,
      returned: reports.length,
      has_more: offset + reports.length < (count ?? reports.length),
      next_offset:
        offset + reports.length < (count ?? reports.length)
          ? offset + reports.length
          : null,
    },
    response_format: responseFormat,
    generated_at: new Date().toISOString(),
  });
}
