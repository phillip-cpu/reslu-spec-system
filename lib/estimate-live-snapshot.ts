import {
  projectRollup,
  sectionRollup,
  ffeRollup,
  wholeJobSummary,
} from "@/lib/estimate";
import { buildEstimateFfeItemSnapshots } from "@/lib/estimate-ffe-snapshot";
import { createClient } from "@/lib/supabase/server";
import type { CostSectionWithLines, Measurement, MeasurementWithGroup } from "@/types";
import type { EstimateSnapshot } from "@/types/phase-12a-a";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** Builds a frozen snapshot of a project's current live estimate. */
export async function buildLiveSnapshot(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<EstimateSnapshot | { error: string; status: number }> {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, estimate_markup_pct")
    .eq("id", projectId)
    .single();
  if (projectError || !project) {
    return { error: "Project not found", status: 404 };
  }

  const [
    { data: sections, error: sectionsError },
    { data: variations, error: variationsError },
    { data: items, error: itemsError },
    { data: measurementRows, error: measurementsError },
    { data: sowRows },
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
      .select("id,item_code,name,category,quantity,price_trade,price_rrp,markup_pct,cost_scope,lead_time_weeks,ordered_at,measurement_id,wastage_pct,coverage_per_unit")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("measurements")
      .select("*, measurement_groups(name)")
      .eq("project_id", projectId)
      .order("sort", { ascending: true }),
    supabase
      .from("sow_documents")
      .select("revision_label")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (sectionsError) return { error: sectionsError.message, status: 500 };
  if (variationsError) return { error: variationsError.message, status: 500 };
  if (itemsError) return { error: itemsError.message, status: 500 };
  if (measurementsError) return { error: measurementsError.message, status: 500 };

  const measurements: MeasurementWithGroup[] = (measurementRows ?? []).map((row) => {
    const { measurement_groups, ...rest } = row as unknown as Measurement & {
      measurement_groups: { name: string } | null;
    };
    return { ...(rest as Measurement), group_name: measurement_groups?.name ?? "" };
  });
  const measurementsById = new Map(measurements.map((m) => [m.id, { value: m.value }]));

  const sectionsWithLines: CostSectionWithLines[] = (sections ?? []).map((section) => {
    const lines = ((section as unknown as { cost_lines: CostSectionWithLines["lines"] }).cost_lines ?? [])
      .filter((line) => !line.deleted_at)
      .sort((a, b) => a.sort - b.sort);
    const { cost_lines: omittedCostLines, ...rest } = section as unknown as Record<string, unknown>;
    void omittedCostLines;
    return {
      ...(rest as unknown as CostSectionWithLines),
      lines,
      rollup: sectionRollup(lines, measurementsById, project.estimate_markup_pct ?? 0),
    };
  });

  const allLines = sectionsWithLines.flatMap((section) => section.lines);
  const rollup = projectRollup({
    lines: allLines,
    variations: variations ?? [],
    markupPct: project.estimate_markup_pct ?? 0,
    measurementsById,
  });
  const ffe = ffeRollup(items ?? [], measurementsById);
  const ffeItems = buildEstimateFfeItemSnapshots(items ?? [], ffe, measurementsById);

  return {
    sections: sectionsWithLines,
    markup_pct: project.estimate_markup_pct ?? 0,
    rollup,
    ffe,
    ffe_items: ffeItems,
    wholeJob: wholeJobSummary(rollup, ffe),
    measurements,
    sow_revision_label: sowRows?.[0]?.revision_label ?? null,
  };
}
