import assert from "node:assert/strict";
import test from "node:test";
import { reorderSowLines } from "./sow-reorder.ts";

const lines = [
  { id: "a", sort: 10 },
  { id: "b", sort: 20 },
  { id: "c", sort: 30 },
];

test("moves a SOW line and normalises the persisted sort order", () => {
  assert.deepEqual(reorderSowLines(lines, "a", 2), [
    { id: "b", sort: 1 },
    { id: "c", sort: 2 },
    { id: "a", sort: 3 },
  ]);
});

test("clamps destinations and ignores an unknown line", () => {
  assert.deepEqual(reorderSowLines(lines, "c", -10).map((line) => line.id), ["c", "a", "b"]);
  assert.equal(reorderSowLines(lines, "missing", 1), lines);
});
