export interface ForecastSchedulePhase {
  start_date?: string | null;
  end_date?: string | null;
}

export interface ForecastScheduleSummary {
  phaseCount: number;
  datedPhaseCount: number;
  latestScheduleDate: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Summarises Timeline coverage for the Finance readiness panel. Date-only
 * strings can be compared lexically, avoiding timezone drift at midnight.
 */
export function summarizeForecastSchedule(
  phases: ForecastSchedulePhase[]
): ForecastScheduleSummary {
  const dates: string[] = [];
  let datedPhaseCount = 0;

  for (const phase of phases) {
    const start = phase.start_date?.slice(0, 10) ?? null;
    const end = phase.end_date?.slice(0, 10) ?? null;
    const hasStart = Boolean(start && ISO_DATE.test(start));
    const hasEnd = Boolean(end && ISO_DATE.test(end));

    if (hasStart && hasEnd) datedPhaseCount += 1;
    if (hasStart) dates.push(start as string);
    if (hasEnd) dates.push(end as string);
  }

  dates.sort();
  return {
    phaseCount: phases.length,
    datedPhaseCount,
    latestScheduleDate: dates.at(-1) ?? null,
  };
}
