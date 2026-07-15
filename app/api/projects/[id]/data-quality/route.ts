import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
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
      { error: "Only admins can access project data quality" },
      { status: 403 }
    );
  }

  try {
    return NextResponse.json(await loadProjectDataQuality(supabase, projectId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load project health" },
      { status: 500 }
    );
  }
}
