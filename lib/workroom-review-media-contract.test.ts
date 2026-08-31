import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("review media is private, hash-bound and conversation scoped", () => {
  const migration = read("supabase/migrations/20260831110302_workroom_review_media.sql");
  assert.match(migration, /source_sha256[\s\S]*\^\[a-f0-9\]\{64\}\$/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /is_conversation_member\(task\.conversation_id\)/);
  assert.match(migration, /grant select.*authenticated/i);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*authenticated/i);
});

test("Workroom hydrates stable authenticated media URLs without exposing storage paths", () => {
  const route = read("app/api/workroom/route.ts");
  const mediaRoute = read("app/api/workroom/media/[id]/route.ts");
  assert.match(route, /workroom_review_media/);
  assert.match(route, /`\/api\/workroom\/media\/\$\{media\.id\}`/);
  assert.doesNotMatch(route, /preview_storage_path/);
  assert.match(mediaRoute, /auth\.getUser\(\)/);
  assert.match(mediaRoute, /agent_task_artifact_media/);
  assert.match(mediaRoute, /Cache-Control[\s\S]*private/);
  assert.match(mediaRoute, /X-Content-Type-Options[\s\S]*nosniff/);
});

test("the local ingester verifies source hashes before creating previews", () => {
  const uploader = read("scripts/upload-workroom-review-media.mjs");
  assert.match(uploader, /actualSourceHash !== row\.sha256/);
  assert.match(uploader, /"-Z", "1600"/);
  assert.match(uploader, /workroom\/review-media\/\$\{artifactId\}/);
  assert.match(uploader, /artifact\.status !== "draft"/);
});

test("the shared agent bridge automatically prepares review media for every agent", () => {
  const bridge = read("scripts/conversation_agent_bridge.py");
  assert.match(bridge, /def ingest_workroom_review_media/);
  assert.match(bridge, /review_media_sources/);
  assert.match(bridge, /Review media needs attention/);
  assert.match(bridge, /def supersede_matching_approval_tasks/);
});
