import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { projectRollup, sectionRollup, ffeRollup, wholeJobSummary } from "@/lib/estimate";
import type { CostSectionWithLines, EstimateResponse } from "@/types";

/**
 * GET /api/projects/[id]/estimate
 * Returns the project's cost sections + lines with computed rollups
 * (per-section subtotal cost/quoted/actual/variance; all-trades
 * subtotal; markup pct/$ from projects.estimate_markup_pct; total ex
 * GST; GST 10%; total inc GST; approved variations folded in) — per
 * BUILD-SPEC.md "Estimating module — enriched from Phillip's Excel
 * template".
 *
 * Week 6 additive: also returns `ffe` (the "FF&E — from schedule"
 * block computed from the project's non-deleted items — see
 * lib/estimate.ts ffeRollup()) and `wholeJob` (trades + FF&E folded
 * together — see lib/estimate.ts wholeJobSummary()). Schedule items are
 * NEVER turned into cost_lines rows; this is a pure read-side
 * computation over `items`, per BUILD-SPEC.md "Estimate ↔ Schedule
 * integration".
 *
 * Admin-only, server-enforced: this whole surface is financial data
 * (BUILD-SPEC.md §Financial visibility), so a non-admin gets 403
 * before any estimate query runs — no data of any kind is included in
 * a non-admin response, per this feature's build brief. This also
 * covers the new items query below: price_trade/price_rrp are
 * financial, so fetching them here (rather than via the team-visible
 * items API) is safe only because this whole route is already
 * admin-gated before any query executes.
 */
export async function GET(
  _request: NextRequest,
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

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, estimate_markup_pct")
    .eq("id", projectId)
    .single();
  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [
    { data: sections, error: sectionsError },
    { data: variations, error: variationsError },
    { data: items, error: itemsError },
  ] = await Promise.all([
    supabase
      .from("cost_sections")
      .select("*, cost_lines(*)")
      .eq("project_id", projectId)
      .order("sort", { ascending: true }),
    supabase
      .from("variations")
      .select("status, cost_ex_gst")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("items")
      .select("id, category, quantity, price_trade, price_rrp")
      .eq("project_id", projectId)
      .is("deleted_at", null),
  ]);

  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }
  if (variationsError) {
    return NextResponse.json({ error: variationsError.message }, { status: 500 });
  }
  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  const sectionsWithLines: CostSectionWithLines[] = (sections ?? []).map((section) => {
    const lines = ((section as unknown as { cost_lines: CostSectionWithLines["lines"] }).cost_lines ?? [])
      .filter((l) => !l.deleted_at)
      .sort((a, b) => a.sort - b.sort);
    const { cost_lines: _omit, ...rest } = section as unknown as Record<string, unknown>;
    void _omit;
    return {
      ...(rest as unknown as CostSectionWithLines),
      lines,
      rollup: sectionRollup(lines),
    };
  });

  const allLines = sectionsWithLines.flatMap((s) => s.lines);
  const rollup = projectRollup({
    lines: allLines,
    variations: variations ?? [],
    markupPct: project.estimate_markup_pct ?? 0,
  });

  const ffe = ffeRollup(items ?? []);
  const wholeJob = wholeJobSummary(rollup, ffe);

  const payload: EstimateResponse = {
    sections: sectionsWithLines,
    markup_pct: project.estimate_markup_pct ?? 0,
    rollup,
    ffe,
    wholeJob,
  };

  return NextResponse.json(payload);
}
