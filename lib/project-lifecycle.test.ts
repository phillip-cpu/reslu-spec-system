import assert from "node:assert/strict";
import test from "node:test";
import {
  lifecycleStepIndex,
  nextProjectStage,
  projectStageForLeadStage,
  projectStatusForStage,
} from "./project-lifecycle.ts";

test("maps detailed project stages onto the five visible lifecycle steps", () => {
  assert.equal(lifecycleStepIndex("quoting"), 1);
  assert.equal(lifecycleStepIndex("design"), 2);
  assert.equal(lifecycleStepIndex("preconstruction"), 3);
  assert.equal(lifecycleStepIndex("handover"), 3);
  assert.equal(lifecycleStepIndex("complete"), 4);
  assert.equal(lifecycleStepIndex("on_hold"), null);
});

test("moves through the canonical proposal, design, construction and finalised progression", () => {
  assert.equal(nextProjectStage("quoting"), "design");
  assert.equal(nextProjectStage("design"), "construction");
  assert.equal(nextProjectStage("construction"), "complete");
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
