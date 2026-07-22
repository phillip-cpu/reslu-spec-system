import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionOrganicAction,
  isOrganicActionStatus,
} from "./organic-actions.ts";

test("organic workflow requires approval before work and monitoring before completion", () => {
  assert.equal(canTransitionOrganicAction("new", "approved"), true);
  assert.equal(canTransitionOrganicAction("new", "in_progress"), false);
  assert.equal(canTransitionOrganicAction("approved", "in_progress"), true);
  assert.equal(canTransitionOrganicAction("in_progress", "monitoring"), true);
  assert.equal(canTransitionOrganicAction("in_progress", "complete"), false);
  assert.equal(canTransitionOrganicAction("monitoring", "complete"), true);
});

test("organic workflow supports dismissal and controlled reopening", () => {
  assert.equal(canTransitionOrganicAction("new", "dismissed"), true);
  assert.equal(canTransitionOrganicAction("dismissed", "new"), true);
  assert.equal(canTransitionOrganicAction("complete", "in_progress"), true);
  assert.equal(isOrganicActionStatus("published"), false);
  assert.equal(isOrganicActionStatus("approved"), true);
});
