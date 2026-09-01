import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBoardPhaseName,
  summarizeBoardReadiness,
} from "./board-readiness.ts";

test("normalizes phase names for duplicate prevention", () => {
  assert.equal(normalizeBoardPhaseName("  Fit-Off  "), "fit-off");
  assert.equal(normalizeBoardPhaseName("Fit   Off"), "fit off");
});

test("surfaces timeline-blocking board structure gaps", () => {
  const summary = summarizeBoardReadiness(
    [
      { name: "Fit-off", phase_start_date: null, phase_end_date: null },
      { name: " FIT-OFF ", phase_start_date: "2026-09-01", phase_end_date: "2026-09-05" },
      { name: "Rough-in", phase_start_date: "2026-09-06", phase_end_date: null },
    ],
    [
      { phase_group_id: null, parent_task_id: null },
      { phase_group_id: null, parent_task_id: "parent" },
      { phase_group_id: "rough-in", parent_task_id: null },
    ]
  );

  assert.deepEqual(summary, {
    phasesMissingDates: 2,
    ungroupedItems: 1,
    duplicatePhaseNames: ["Fit-off"],
    ready: false,
  });
});

test("reports a board ready when phases, dates and assignments are coherent", () => {
  const summary = summarizeBoardReadiness(
    [
      {
        name: "Site setup",
        phase_start_date: "2026-09-01",
        phase_end_date: "2026-09-02",
      },
    ],
    [{ phase_group_id: "site", parent_task_id: null }]
  );

  assert.equal(summary.ready, true);
});
