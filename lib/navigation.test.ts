import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSidebarOrder, projectShortcutLabel } from "./navigation.ts";

test("sidebar order removes stale and duplicate ids while appending new items", () => {
  const order = normalizeSidebarOrder(["projects", "my-work", "projects", "retired"], false);
  assert.deepEqual(order.slice(0, 2), ["projects", "my-work"]);
  assert.equal(new Set(order).size, order.length);
  assert.equal(order.includes("retired"), false);
  assert.equal(order.includes("health"), false);
  assert.equal(order.includes("settings"), true);
});

test("recent project shortcuts use compact recognisable initials", () => {
  assert.equal(projectShortcutLabel("Goldsworthy Virgo"), "GV");
  assert.equal(projectShortcutLabel("Conessa"), "CO");
});

