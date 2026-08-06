import assert from "node:assert/strict";
import test from "node:test";
import { parseServerFeatureFlag } from "./feature-flags.ts";

test("finance feature flags fail closed", () => {
  assert.equal(parseServerFeatureFlag(undefined), false);
  assert.equal(parseServerFeatureFlag(""), false);
  assert.equal(parseServerFeatureFlag("1"), false);
  assert.equal(parseServerFeatureFlag("false"), false);
  assert.equal(parseServerFeatureFlag("true"), true);
  assert.equal(parseServerFeatureFlag(" TRUE "), true);
});
