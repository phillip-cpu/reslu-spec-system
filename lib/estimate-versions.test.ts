import assert from "node:assert/strict";
import test from "node:test";
import { suggestNextLabel } from "./estimate-version-labels.ts";

test("estimate versions start with a usable label", () => {
  assert.equal(suggestNextLabel([]), "V1");
});

test("estimate version labels advance across issue and VM versions", () => {
  const labels = ["V1", "VM_V2", "client option"];
  assert.equal(suggestNextLabel(labels, "issue"), "V3");
  assert.equal(suggestNextLabel(labels, "vm"), "VM_V3");
});
