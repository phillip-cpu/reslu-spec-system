import assert from "node:assert/strict";
import test from "node:test";
import { isValidAustralianAbn, normalizeAustralianAbn } from "./supplier-identity.ts";

test("normalises and validates an Australian ABN", () => {
  assert.equal(normalizeAustralianAbn("44 669 823 027"), "44669823027");
  assert.equal(isValidAustralianAbn("44 669 823 027"), true);
  assert.equal(isValidAustralianAbn("44 669 823 028"), false);
  assert.equal(isValidAustralianAbn("4466982302"), false);
});
