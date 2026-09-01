import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBoardPlanOverview, type BoardPlanOverviewTask } from "./board-plan-overview.ts";

const task = (
  title: string,
  columnId: string,
  patch: Partial<BoardPlanOverviewTask> = {}
): BoardPlanOverviewTask => ({
  title,
  parent_task_id: null,
  column_id: columnId,
  booking_date: null,
  due_date: null,
  ...patch,
});

test("summarises top-level completion, scheduling and the next open item", () => {
  assert.deepEqual(
    summarizeBoardPlanOverview({
      tasks: [
        task("Site fencing", "done", { due_date: "2026-09-04" }),
        task("Skip bin", "open", { booking_date: "2026-09-05" }),
        task("Child delivery", "done", { parent_task_id: "parent" }),
      ],
      doneColumnIds: new Set(["done"]),
      phaseCount: 4,
      phasesMissingDates: 1,
    }),
    {
      totalTasks: 2,
      completedTasks: 1,
      scheduledTasks: 2,
      readyPhases: 3,
      progressPercent: 50,
      nextOpenTask: "Skip bin",
    }
  );
});

test("keeps an empty plan stable and never reports negative ready phases", () => {
  assert.deepEqual(
    summarizeBoardPlanOverview({
      tasks: [],
      doneColumnIds: new Set(),
      phaseCount: 0,
      phasesMissingDates: 2,
    }),
    {
      totalTasks: 0,
      completedTasks: 0,
      scheduledTasks: 0,
      readyPhases: 0,
      progressPercent: 0,
      nextOpenTask: null,
    }
  );
});
