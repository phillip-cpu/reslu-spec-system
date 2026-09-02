import assert from "node:assert/strict";
import test from "node:test";
import { buildSowLineCopies } from "./sow-copy-lines.ts";

test("copies line content and appends it in source order to every target room", () => {
  const copies = buildSowLineCopies(
    [
      { text: "Remove existing window", kind: "inclusion", trade: "Demolition" },
      { text: "Refer to detail A12", kind: "note", trade: null },
    ],
    ["laundry", "powder"],
    new Map([
      ["laundry", 8],
      ["powder", 3],
    ])
  );

  assert.deepEqual(copies, [
    { section_id: "laundry", text: "Remove existing window", kind: "inclusion", trade: "Demolition", sort: 9 },
    { section_id: "laundry", text: "Refer to detail A12", kind: "note", trade: null, sort: 10 },
    { section_id: "powder", text: "Remove existing window", kind: "inclusion", trade: "Demolition", sort: 4 },
    { section_id: "powder", text: "Refer to detail A12", kind: "note", trade: null, sort: 5 },
  ]);
});
