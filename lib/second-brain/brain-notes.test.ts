import assert from "node:assert/strict";
import test from "node:test";
import { isMarcoBrainNote, normalizeBrainNoteSource } from "./brain-notes.ts";

test("normalizes agent source ids", () => {
  assert.equal(normalizeBrainNoteSource(" Marco "), "marco");
  assert.equal(normalizeBrainNoteSource(undefined), "aria");
});

test("routes only Marco-owned notes into the marketing cluster", () => {
  assert.equal(isMarcoBrainNote({ source: "marco" }), true);
  assert.equal(isMarcoBrainNote({ source: " MARCO " }), true);
  assert.equal(isMarcoBrainNote({ source: "aria" }), false);
});

