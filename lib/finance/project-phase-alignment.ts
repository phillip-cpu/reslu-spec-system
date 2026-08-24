import type { SupabaseClient } from "@supabase/supabase-js";

export interface ForecastPhaseCandidate {
  id: string;
  name: string;
  sort?: number;
}

export interface ForecastCostSection {
  id: string;
  name: string;
  forecast_phase_id: string | null;
}

export interface CostSectionPhaseUpdate {
  id: string;
  forecast_phase_id: string;
}

type AlignmentRule = {
  section: RegExp;
  phases: RegExp[];
};

// Rules are intentionally based on the estimate's trade headings and the
// project's standard Timeline vocabulary. The first phase expression that
// matches wins, allowing an extension/new-build Earthworks phase to win while
// renovations fall back to Structural Alterations for the same cost section.
const ALIGNMENT_RULES: AlignmentRule[] = [
  { section: /prelim|site establishment/i, phases: [/site establishment/i] },
  { section: /demolition|strip out/i, phases: [/demolition|strip out/i] },
  { section: /earthwork|footing|slab|base/i, phases: [/earthworks|footings|base/i, /structural/i] },
  { section: /framing|carpentry|structural|steel/i, phases: [/structural.*framing|structural alterations/i] },
  { section: /roof|brick|masonry|cladding/i, phases: [/external envelope/i] },
  { section: /glazing|shower screen|mirror/i, phases: [/fit off/i, /internal finishes/i, /external envelope/i] },
  { section: /plaster|render|lining|insulation|waterproof/i, phases: [/internal linings.*waterproof/i] },
  { section: /stone|benchtop/i, phases: [/joinery.*fixed/i, /internal finishes/i] },
  { section: /tiling|floor covering/i, phases: [/internal finishes/i] },
  { section: /window furnishing/i, phases: [/fit off/i, /internal finishes/i] },
  { section: /plumbing|electrical|hvac|data|services/i, phases: [/services rough in/i] },
  { section: /joinery|cabinet/i, phases: [/joinery.*fixed/i, /fit off/i] },
  { section: /paint|decorative/i, phases: [/painting.*final/i] },
  { section: /appliance|hardware|fit off/i, phases: [/fit off/i] },
  { section: /external|landscap|paving|fencing|drainage/i, phases: [/external works/i] },
  { section: /handover|completion/i, phases: [/handover.*close out/i, /practical completion/i] },
];

export function suggestForecastPhaseId(
  sectionName: string,
  phases: ForecastPhaseCandidate[]
): string | null {
  const rule = ALIGNMENT_RULES.find((candidate) => candidate.section.test(sectionName));
  if (!rule) return null;
  const ordered = [...phases].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  for (const phasePattern of rule.phases) {
    const match = ordered.find((phase) => phasePattern.test(phase.name));
    if (match) return match.id;
  }
  return null;
}

export function buildUnmappedCostSectionPhaseUpdates(
  sections: ForecastCostSection[],
  phases: ForecastPhaseCandidate[]
): CostSectionPhaseUpdate[] {
  return sections.flatMap((section) => {
    if (section.forecast_phase_id) return [];
    const forecastPhaseId = suggestForecastPhaseId(section.name, phases);
    return forecastPhaseId ? [{ id: section.id, forecast_phase_id: forecastPhaseId }] : [];
  });
}

/**
 * Applies deterministic defaults only to unlinked estimate sections. The
 * additional `is null` filter protects a manual link made between the read and
 * update, so this helper never replaces the team's chosen cash-out timing.
 */
export async function alignUnmappedCostSectionsToTimeline(
  supabase: SupabaseClient,
  projectId: string
): Promise<CostSectionPhaseUpdate[]> {
  const [{ data: phases }, { data: sections }] = await Promise.all([
    supabase
      .from("schedule_phases")
      .select("id, name, sort")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("cost_sections")
      .select("id, name, forecast_phase_id")
      .eq("project_id", projectId),
  ]);

  const updates = buildUnmappedCostSectionPhaseUpdates(
    (sections ?? []) as ForecastCostSection[],
    (phases ?? []) as ForecastPhaseCandidate[]
  );
  await Promise.all(
    updates.map((update) =>
      supabase
        .from("cost_sections")
        .update({ forecast_phase_id: update.forecast_phase_id })
        .eq("project_id", projectId)
        .eq("id", update.id)
        .is("forecast_phase_id", null)
    )
  );
  return updates;
}
