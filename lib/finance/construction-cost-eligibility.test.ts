import assert from "node:assert/strict";
import test from "node:test";
import { includesConstructionCosts } from "./construction-cost-eligibility.ts";

test("design and quoting jobs never carry the build estimate as project cost", () => {
  assert.equal(includesConstructionCosts("design", "design"), false);
  assert.equal(includesConstructionCosts("design", "construction"), false);
  assert.equal(includesConstructionCosts("quoting", "construction"), false);
});

test("a design fee never activates construction costs in a later stage", () => {
  assert.equal(includesConstructionCosts("preconstruction", "design"), false);
  assert.equal(includesConstructionCosts("construction", "design"), false);
});

test("construction costs start only after a construction contract advances", () => {
  assert.equal(includesConstructionCosts("preconstruction", "construction"), true);
  assert.equal(includesConstructionCosts("construction", "construction"), true);
  assert.equal(includesConstructionCosts("on_hold", "construction"), true);
});
