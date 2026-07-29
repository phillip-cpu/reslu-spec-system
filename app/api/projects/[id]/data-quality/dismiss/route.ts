import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { loadProjectDataQuality } from "@/lib/project-data-quality-server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const DISMISSIBLE_AREAS = new Set(["register", "pricing"]);

export async function POST(
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
      { error: "Only admins can dismiss project data-quality issues" },
      { status: 403 }
    );
  }

  let body: { code?: unknown; fingerprint?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const fingerprint =
    typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  if (!code || !fingerprint) {
    return NextResponse.json(
      { error: "code and fingerprint are required" },
      { status: 400 }
    );
  }

  const report = await loadProjectDataQuality(supabase, projectId);
  const issue = report.issues.find((candidate) => candidate.code === code);
  if (!issue) {
    return NextResponse.json(
      { error: "This issue has already been resolved" },
      { status: 409 }
    );
  }
  if (!DISMISSIBLE_AREAS.has(issue.area)) {
    return NextResponse.json(
      { error: "Procurement and programme risks cannot be dismissed here" },
      { status: 400 }
    );
  }
  if (issue.fingerprint !== fingerprint) {
    return NextResponse.json(
      { error: "The affected records changed. Refresh and review the updated issue." },
      { status: 409 }
    );
  }

  const { error } = await supabase
    .from("project_data_quality_dismissals")
    .upsert(
      {
        project_id: projectId,
        issue_code: code,
        issue_fingerprint: fingerprint,
        dismissed_by: info.userId,
        dismissed_at: new Date().toISOString(),
      },
      { onConflict: "project_id,issue_code" }
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ dismissed: true });
}

export async function DELETE(
  _request: Request,
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
      { error: "Only admins can restore project data-quality issues" },
      { status: 403 }
    );
  }

  const { error } = await supabase
    .from("project_data_quality_dismissals")
    .delete()
    .eq("project_id", projectId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ restored: true });
}

