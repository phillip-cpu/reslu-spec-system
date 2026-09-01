export interface BoardPlanOverviewTask {
  title: string;
  parent_task_id: string | null;
  column_id: string;
  booking_date: string | null;
  due_date: string | null;
}

export interface BoardPlanOverview {
  totalTasks: number;
  completedTasks: number;
  scheduledTasks: number;
  readyPhases: number;
  progressPercent: number;
  nextOpenTask: string | null;
}

/**
 * Builds the small, decision-first summary at the top of the Job Work
 * plan. Sub-items are deliberately excluded from the headline totals:
 * they already roll up visually under a parent and counting them again
 * makes the overall completion number jump when a task is merely broken
 * into more detail.
 */
export function summarizeBoardPlanOverview({
  tasks,
  doneColumnIds,
  phaseCount,
  phasesMissingDates,
}: {
  tasks: BoardPlanOverviewTask[];
  doneColumnIds: Set<string>;
  phaseCount: number;
  phasesMissingDates: number;
}): BoardPlanOverview {
  const topLevelTasks = tasks.filter((task) => !task.parent_task_id);
  const completedTasks = topLevelTasks.filter((task) => doneColumnIds.has(task.column_id));
  const scheduledTasks = topLevelTasks.filter(
    (task) => Boolean(task.booking_date) || Boolean(task.due_date)
  );
  const nextOpenTask = topLevelTasks.find((task) => !doneColumnIds.has(task.column_id));

  return {
    totalTasks: topLevelTasks.length,
    completedTasks: completedTasks.length,
    scheduledTasks: scheduledTasks.length,
    readyPhases: Math.max(0, phaseCount - phasesMissingDates),
    progressPercent:
      topLevelTasks.length > 0
        ? Math.round((completedTasks.length / topLevelTasks.length) * 100)
        : 0,
    nextOpenTask: nextOpenTask?.title ?? null,
  };
}
