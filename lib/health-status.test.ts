import assert from "node:assert/strict";
import test from "node:test";
import { overallHealthLevel } from "./health-status.ts";

test("sidebar health uses the most serious live signal", () => {
  assert.equal(overallHealthLevel(["green", "green"]), "green");
  assert.equal(overallHealthLevel(["green", "amber"]), "amber");
  assert.equal(overallHealthLevel(["green"], { failedEmailSends: 1 }), "amber");
  assert.equal(overallHealthLevel(["green"], { stuckAriaQueue: 1 }), "red");
  assert.equal(overallHealthLevel(["green"], { openclawUp: false }), "red");
});

