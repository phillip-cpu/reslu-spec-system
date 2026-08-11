import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/111_agent_task_safe_retry.sql");
const verifier = read("supabase/fixtures/111_agent_task_safe_retry_verify.sql");
const route = read("app/api/conversations/[id]/tasks/[taskId]/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const bridge = read("scripts/conversation_agent_bridge.py");

test("failed task recovery is explicit, requester-only and identity preserving", () => {
  assert.match(migration, /create or replace function retry_failed_agent_task/i);
  assert.match(migration, /task\.requested_by = auth\.uid\(\)/i);
  assert.match(migration, /current_task\.status <> 'failed'/i);
  assert.match(migration, /current_task\.approval_state = 'approved'/i);
  assert.match(migration, /current_task\.approval_state = 'pending'/i);
  assert.match(migration, /artifact\.status in \('approved', 'published'\)/i);
  assert.match(migration, /event\.event_type = 'approved'/i);
  assert.match(migration, /retry_count between 0 and 3/i);
  assert.match(migration, /task\.retry_count \+ 1/i);
  assert.match(migration, /gateway_run_id = null/i);
  assert.match(migration, /set\s+status = 'queued'/i);
  assert.doesNotMatch(migration, /insert into agent_tasks/i);
  assert.match(migration, /'Task queued again'/i);
  assert.match(migration, /revoke all on function retry_failed_agent_task\(uuid, uuid\) from public, anon/i);
});

test("the authenticated task route exposes only the guarded database action", () => {
  assert.match(route, /body\.action === "retry"/);
  assert.match(route, /supabase\.rpc\("retry_failed_agent_task"/);
  assert.doesNotMatch(route, /\.from\("agent_tasks"\)\.update/);
});

test("the task card confirms safe recovery and refuses to replay approved work", () => {
  assert.match(workspace, /Retry this task\?/);
  assert.match(workspace, /No approved external action will be replayed/);
  assert.match(workspace, /retryBlockedByApproval/);
  assert.match(workspace, /artifact\.status === "approved" \|\| artifact\.status === "published"/);
  assert.match(workspace, /still has an unresolved approval/i);
  assert.match(workspace, /Check the relevant email, booking or record before starting new work/);
  assert.match(workspace, /Only the person who started this task can retry it/);
  assert.match(workspace, /task\.retry_count < 3/);
  assert.match(workspace, /reached its safe retry limit/);
});

test("the bridge has no blind failed-task auto-retry loop", () => {
  assert.match(bridge, /"status": "failed"/);
  assert.doesNotMatch(bridge, /if task\["status"\] == "failed"/);
  assert.match(bridge, /idempotency_key=f"reslu-task-\{task\['id'\]\}-attempt-\{int\(task\.get\('retry_count'\) or 0\)\}"/);
});

test("the hosted verifier proves safe replay refusal and rolls back", () => {
  assert.match(verifier, /retry_failed_agent_task/);
  assert.match(verifier, /approved task cannot be retried automatically/);
  assert.match(verifier, /task with pending approval cannot be retried/);
  assert.match(verifier, /task with an approved artifact was allowed to retry/i);
  assert.match(verifier, /task retry limit reached/);
  assert.match(verifier, /gateway_run_id is not null/);
  assert.match(verifier, /when sqlstate 'P5099'/);
  assert.match(verifier, /all test changes rolled back/i);
});
