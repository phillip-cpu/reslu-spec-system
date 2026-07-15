import assert from "node:assert/strict";
import test from "node:test";
import {
  automationMarker,
  futureNurtureMilestone,
  projectHealthPriority,
} from "./aria-action-rules.ts";

test("future nurture uses one current 30/60/90 milestone", () => {
  assert.equal(futureNurtureMilestone(29), null);
  assert.equal(futureNurtureMilestone(30), 30);
  assert.equal(futureNurtureMilestone(59), 30);
  assert.equal(futureNurtureMilestone(60), 60);
  assert.equal(futureNurtureMilestone(89), 60);
  assert.equal(futureNurtureMilestone(90), 90);
  assert.equal(futureNurtureMilestone(180), 90);
});

test("automation markers are stable business keys for Office dedupe", () => {
  assert.equal(
    automationMarker("project-health:project-1:ordering_overdue"),
    "RESLU automation key: project-health:project-1:ordering_overdue"
  );
});

test("Phase 5 project-health priorities put critical work first", () => {
  assert.equal(projectHealthPriority("critical", "ordering_overdue"), "today");
  assert.equal(projectHealthPriority("warning", "trade_confirmation_due"), "this_week");
  assert.equal(projectHealthPriority("warning", "supplier_missing"), "monitor");
});
