import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { projectRollup, sectionRollup, ffeRollup, wholeJobSummary } from "@/lib/estimate";
import type { CostSectionWithLines, EstimateResponse, Measurement, MeasurementWithGroup } from "@/types";

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
 * Week 7 additive: also returns `measurements` (every measurement for
 * the project, flat, with its group's name attached) — needed so a
 * cost line linked via `measurement_id` can be costed using
 * lib/estimate.ts effectiveQty() (measurement value × (1 + wastage%))
 * rather than its own possibly-stale `qty` column, and so the UI can
 * show a linked line's resolved label/value without a second fetch.
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
    { data: measurementRows, error: measurementsError },
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
    // Round B additive: measurement_id/wastage_pct/coverage_per_unit
    // (migration 027) selected too, so ffeRollup() below can derive a
    // takeoff-linked item's quantity instead of trusting a possibly-
    // stale `quantity` column — see lib/estimate.ts ffeRollup()'s doc
    // comment for the backwards-compatible cascade.
    supabase
      .from("items")
      .select(
        "id, category, quantity, price_trade, price_rrp, measurement_id, wastage_pct, coverage_per_unit"
      )
      .eq("project_id", projectId)
      .is("deleted_at", null),
    // measurement_groups(name) nested for group_name — Week 7, needed
    // for effectiveQty() on linked cost lines and the link-picker UI.
    supabase
      .from("measurements")
      .select("*, measurement_groups(name)")
      .eq("project_id", projectId)
      .order("sort", { ascending: true }),
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
  if (measurementsError) {
    return NextResponse.json({ error: measurementsError.message }, { status: 500 });
  }

  const measurements: MeasurementWithGroup[] = (measurementRows ?? []).map((row) => {
    const { measurement_groups, ...rest } = row as unknown as Measurement & {
      measurement_groups: { name: string } | null;
    };
    return { ...(rest as Measurement), group_name: measurement_groups?.name ?? "" };
  });
  const measurementsById = new Map(measurements.map((m) => [m.id, { value: m.value }]));

  const sectionsWithLines: CostSectionWithLines[] = (sections ?? []).map((section) => {
    const lines = ((section as unknown as { cost_lines: CostSectionWithLines["lines"] }).cost_lines ?? [])
      .filter((l) => !l.deleted_at)
      .sort((a, b) => a.sort - b.sort);
    const { cost_lines: _omit, ...rest } = section as unknown as Record<string, unknown>;
    void _omit;
    return {
      ...(rest as unknown as CostSectionWithLines),
      lines,
      rollup: sectionRollup(lines, measurementsById),
    };
  });

  const allLines = sectionsWithLines.flatMap((s) => s.lines);
  const rollup = projectRollup({
    lines: allLines,
    variations: variations ?? [],
    markupPct: project.estimate_markup_pct ?? 0,
    measurementsById,
  });

  // Round B additive: same measurementsById map already built above for
  // cost-line effectiveQty() now also drives ffeRollup()'s derived
  // quantity for takeoff-linked FF&E items (see lib/estimate.ts
  // ffeRollup()'s doc comment) — one shared map, two rollups.
  const ffe = ffeRollup(items ?? [], measurementsById);
  // Category prefixes alone (DR, FA, HD…) read as cryptic in the FF&E
  // block (Phillip, 6 Jul) — attach display names from the categories
  // table so rows render "DR — Doors".
  {
    const { data: cats } = await supabase
      .from("categories")
      .select("prefix,name");
    const nameByPrefix = new Map(
      (cats ?? []).map((c: { prefix: string; name: string }) => [c.prefix, c.name])
    );
    for (const row of ffe.categories as Array<{ category: string; category_name?: string }>) {
      row.category_name = nameByPrefix.get(row.category) ?? "";
    }
  }
  const wholeJob = wholeJobSummary(rollup, ffe);

  const payload: EstimateResponse = {
    sections: sectionsWithLines,
    markup_pct: project.estimate_markup_pct ?? 0,
    rollup,
    ffe,
    wholeJob,
    measurements,
  };

  return NextResponse.json(payload);
}
