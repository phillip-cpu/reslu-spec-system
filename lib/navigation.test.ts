import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSidebarOrder, projectShortcutLabel } from "./navigation.ts";

test("sidebar order removes stale and duplicate ids while positioning new items", () => {
  const order = normalizeSidebarOrder(["projects", "my-work", "projects", "retired"], false);
  assert.deepEqual(order.slice(0, 2), ["projects", "my-work"]);
  assert.equal(new Set(order).size, order.length);
  assert.equal(order.includes("retired"), false);
  assert.equal(order.includes("health"), false);
  assert.equal(order.includes("second-brain"), true);
  assert.equal(order.includes("settings"), true);
});

test("a newly introduced Workroom stays visible beside Messages", () => {
  const previousSidebar = [
    "my-work",
    "projects",
    "office",
    "friday-review",
    "library",
    "cpd",
    "contacts",
    "settings",
    "blog",
    "search",
    "messages",
    "second-brain",
  ];
  const order = normalizeSidebarOrder(previousSidebar, false);

  assert.equal(order.indexOf("workroom"), order.indexOf("messages") + 1);
  assert.equal(order.at(-1), "second-brain");
});

test("an explicitly arranged Workroom position remains untouched", () => {
  const arranged = ["workroom", "messages", "my-work", "projects"];
  const order = normalizeSidebarOrder(arranged, false);

  assert.deepEqual(order.slice(0, 4), arranged);
});

test("recent project shortcuts use compact recognisable initials", () => {
  assert.equal(projectShortcutLabel("Goldsworthy Virgo"), "GV");
  assert.equal(projectShortcutLabel("Conessa"), "CO");
});
