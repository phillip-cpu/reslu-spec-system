import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(resolve(root, "scripts/meeting_mode_acceptance.mjs"), "utf8");

test("production Meeting Mode acceptance covers lead, project and ambiguity safeguards", () => {
  assert.match(script, /RESLU_RUN_PRODUCTION_MEETING_ACCEPTANCE/);
  assert.match(script, /destinationKind: "lead"/);
  assert.match(script, /destinationKind: "project"/);
  assert.match(script, /Two nearby events for the same project were not kept distinct/);
  assert.match(script, /needs_clarification/);
  assert.match(script, /unassignedApproval\.response\.status, 409/);
  assert.match(script, /choose a lead or project/);
  assert.match(script, /staleApproval\.response\.status, 409/);
  assert.match(script, /destination_changed/);
  assert.match(script, /Meeting Mode lead, project and ambiguous-destination matrix completed/);
});

test("production Meeting Mode acceptance remains explicit, exact and self-cleaning", () => {
  assert.match(script, /assertNoTimelineRecord/);
  assert.match(script, /did not create exactly one linked timeline record/);
  assert.match(script, /expected_version/);
  assert.match(script, /\.eq\("conversation_id", conversationId\)/);
  assert.match(script, /admin\.storage\.from\("assets"\)\.remove\(recordingPaths\)/);
  assert.match(script, /admin\.auth\.admin\.deleteUser\(userId\)/);
});
