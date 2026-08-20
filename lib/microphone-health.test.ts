import assert from "node:assert/strict";
import test from "node:test";
import { microphoneSamplesAreActive } from "./microphone-health.ts";

test("flat microphone samples are silent", () => {
  assert.equal(microphoneSamplesAreActive(new Uint8Array([128, 128, 128, 128])), false);
});

test("audible microphone samples cross the activity threshold", () => {
  assert.equal(microphoneSamplesAreActive(new Uint8Array([96, 160, 94, 162])), true);
});
