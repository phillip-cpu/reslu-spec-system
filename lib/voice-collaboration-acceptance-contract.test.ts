import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("../scripts/voice_collaboration_acceptance.mjs", import.meta.url),
  "utf8",
);

test("production voice collaboration drill is explicit, read-only and self-cleaning", () => {
  assert.match(script, /RESLU_RUN_PRODUCTION_VOICE_COLLAB_ACCEPTANCE/);
  assert.match(script, /owner_agent_slug: "aria"/);
  assert.match(script, /target_agent_slug: "marco"/);
  assert.match(script, /without taking action/);
  assert.match(script, /repeated\.body\.consultation_id, queued\.body\.consultation_id/);
  assert.match(script, /consultations\.length, 1/);
  assert.match(script, /messages\.length, 2/);
  assert.match(script, /metadata\.owner_agent_slug, "aria"/);
  assert.match(script, /metadata\.consulted_agent_slug, "marco"/);
  assert.match(script, /from\("conversations"\)\.delete/);
  assert.match(script, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(script, /console\.log\([^)]*(password|serviceKey|anonKey|cookie|answer)/);
});
