export interface BoardReadinessGroup {
  name: string;
  phase_start_date: string | null;
  phase_end_date: string | null;
}

export interface BoardReadinessTask {
  phase_group_id: string | null;
  parent_task_id: string | null;
}

export interface BoardReadinessSummary {
  phasesMissingDates: number;
  ungroupedItems: number;
  duplicatePhaseNames: string[];
  ready: boolean;
}

export function normalizeBoardPhaseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
}

/**
 * Small, actionable quality summary for the Work plan. These are structural
 * gaps that make Timeline and future cash forecasting unreliable, rather
 * than task completion metrics.
 */
export function summarizeBoardReadiness(
  groups: BoardReadinessGroup[],
  tasks: BoardReadinessTask[]
): BoardReadinessSummary {
  const names = new Map<string, { label: string; count: number }>();
  for (const group of groups) {
    const key = normalizeBoardPhaseName(group.name);
    if (!key) continue;
    const current = names.get(key);
    names.set(key, {
      label: current?.label ?? group.name.trim(),
      count: (current?.count ?? 0) + 1,
    });
  }

  const duplicatePhaseNames = [...names.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.label)
    .sort((a, b) => a.localeCompare(b, "en-AU"));
  const phasesMissingDates = groups.filter(
    (group) => !group.phase_start_date || !group.phase_end_date
  ).length;
  const ungroupedItems = tasks.filter(
    (task) => !task.parent_task_id && !task.phase_group_id
  ).length;

  return {
    phasesMissingDates,
    ungroupedItems,
    duplicatePhaseNames,
    ready:
      phasesMissingDates === 0 &&
      ungroupedItems === 0 &&
      duplicatePhaseNames.length === 0,
  };
}
