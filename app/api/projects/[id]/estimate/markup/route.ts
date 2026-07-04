import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

/**
 * PATCH /api/projects/[id]/estimate/markup
 * body: { markup_pct: number } — a fraction, e.g. 0.15 for 15%
 * (matches projects.estimate_markup_pct numeric(5,4), see
 * 007_estimating.sql). The UI is responsible for converting a
 * percent-typed input (e.g. "15") to a fraction before sending.
 *
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
 */
export async function PATCH(
  request: NextRequest,
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
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const markupPct = Number(body?.markup_pct);
  if (!Number.isFinite(markupPct) || markupPct < 0 || markupPct > 9.9999) {
    return NextResponse.json(
      { error: "markup_pct must be a fraction between 0 and 9.9999 (e.g. 0.15 for 15%)" },
      { status: 400 }
    );
  }

  const { data: project, error } = await supabase
    .from("projects")
    .update({ estimate_markup_pct: markupPct })
    .eq("id", projectId)
    .select("id, estimate_markup_pct")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ markup_pct: project.estimate_markup_pct });
}
