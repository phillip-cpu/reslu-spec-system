export interface ForecastLinkedCostSection {
  id: string;
  forecast_phase_id: string | null;
}

export interface ForecastSchedulePhase {
  id: string;
  end_date: string;
}

/**
 * Resolves the saved estimate-section -> Timeline-phase relationship into
 * the dates consumed by project and company Finance. The construction
 * program is the source of truth: moving a linked phase automatically moves
 * the projected expense without editing Finance.
 */
export function buildSectionForecastDates(input: {
  sections: ForecastLinkedCostSection[];
  phases: ForecastSchedulePhase[];
}): Record<string, string> {
  const phaseEndDateById = new Map(
    input.phases.map((phase) => [phase.id, phase.end_date])
  );
  const dates: Record<string, string> = {};

  for (const section of input.sections) {
    if (!section.forecast_phase_id) continue;
    const endDate = phaseEndDateById.get(section.forecast_phase_id);
    if (endDate) dates[section.id] = endDate;
  }

  return dates;
}
