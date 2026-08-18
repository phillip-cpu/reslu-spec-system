import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("../scripts/session_revocation_acceptance.mjs", import.meta.url),
  "utf8",
);

test("production session acceptance is explicit, bounded and self-cleaning", () => {
  assert.match(script, /RESLU_RUN_PRODUCTION_SESSION_ACCEPTANCE/);
  assert.match(script, /auth\.admin\.createUser/);
  assert.match(script, /auth\.signOut|sessions\/revoke-others/);
  assert.match(script, /deviceB\.auth\.refreshSession/);
  assert.match(script, /push_subscriptions[\s\S]*other_push_routes_removed/);
  assert.match(script, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(script, /console\.log\([^)]*(password|serviceKey|anonKey|cookie)/);
});
