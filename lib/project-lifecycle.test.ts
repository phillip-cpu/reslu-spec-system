import assert from "node:assert/strict";
import test from "node:test";
import {
  lifecycleStepIndex,
  nextProjectStage,
  projectStageForLeadStage,
  projectStatusForStage,
} from "./project-lifecycle.ts";

test("maps every delivery stage onto its visible lifecycle step", () => {
  assert.equal(lifecycleStepIndex("quoting"), 1);
  assert.equal(lifecycleStepIndex("design"), 2);
  assert.equal(lifecycleStepIndex("preconstruction"), 3);
  assert.equal(lifecycleStepIndex("construction"), 4);
  assert.equal(lifecycleStepIndex("handover"), 5);
  assert.equal(lifecycleStepIndex("complete"), 6);
  assert.equal(lifecycleStepIndex("on_hold"), null);
});

test("moves through every canonical delivery stage without shortcuts", () => {
  assert.equal(nextProjectStage("quoting"), "design");
  assert.equal(nextProjectStage("design"), "preconstruction");
  assert.equal(nextProjectStage("preconstruction"), "construction");
  assert.equal(nextProjectStage("construction"), "handover");
  assert.equal(nextProjectStage("handover"), "complete");
  assert.equal(nextProjectStage("complete"), null);
});

test("finalised controls completed status without unarchiving records", () => {
  assert.equal(projectStatusForStage("complete", "active"), "completed");
  assert.equal(projectStatusForStage("design", "completed"), "active");
  assert.equal(projectStatusForStage("complete", "archived"), "archived");
});

test("lead handoff preserves the strongest known lifecycle stage", () => {
  assert.equal(projectStageForLeadStage("Proposal Sent"), "quoting");
  assert.equal(projectStageForLeadStage("Design Work In Progress"), "design");
  assert.equal(projectStageForLeadStage("Construction In Progress"), "construction");
  assert.equal(projectStageForLeadStage("Complete"), "complete");
});
