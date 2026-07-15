import assert from "node:assert/strict";
import test from "node:test";
import { resolveExportPresets } from "./export-presets.ts";

test("cabinet/joinery presets always retain HD quality-reference coverage", () => {
  const presets = resolveExportPresets([
    { name: "Custom Joinery", prefixes: ["JN"], contact_categories: ["Cabinet Maker"] },
  ]);
  assert.deepEqual(presets[0].prefixes, ["JN", "HD"]);
});

test("adds a Joiner reference preset when a custom list has none", () => {
  const presets = resolveExportPresets([{ name: "Plumber", prefixes: ["TW"] }]);
  const joiner = presets.find((preset) => preset.name === "Joiner");
  assert.deepEqual(joiner?.prefixes, ["HD"]);
});
