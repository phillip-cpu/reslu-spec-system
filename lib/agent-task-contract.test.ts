import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/099_persistent_agent_tasks.sql");
const realtime = read("lib/realtime-voice.ts");
const taskRoute = read("app/api/conversations/[id]/realtime/task/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const bridge = read("scripts/conversation_agent_bridge.py");
const verifier = read("supabase/fixtures/099_persistent_agent_tasks_verify.sql");

test("durable tasks have explicit lifecycle, RLS and service-only claiming", () => {
  assert.match(migration, /create table if not exists agent_tasks/i);
  assert.match(migration, /status in \('queued','running','awaiting_approval','completed','failed','cancelled'\)/i);
  assert.match(migration, /alter table agent_tasks enable row level security/i);
  assert.match(migration, /is_conversation_member\(conversation_id\)/i);
  assert.match(migration, /revoke all on function claim_agent_task\(text\) from public, anon, authenticated/i);
  assert.match(migration, /cancellation_requested_at/i);
});

test("speech creates a task through one idempotent server boundary", () => {
  assert.match(realtime, /name: "start_reslu_task"/);
  assert.match(taskRoute, /client_task_id: body\.clientTaskId/);
  assert.match(taskRoute, /background_task: true/);
  assert.match(migration, /unique \(conversation_id, client_task_id\)/i);
  assert.match(migration, /new\.metadata->>'background_task' = 'true'/i);
});

test("the call surface exposes captions, durable work and approvals", () => {
  assert.match(workspace, /conversation\.item\.input_audio_transcription\.delta/);
  assert.match(workspace, /aria-label="Background agent work"/);
  assert.match(workspace, /aria-label="Call captions"/);
  assert.match(workspace, /setCallTranscriptExpanded\(false\)/);
  assert.ok(workspace.indexOf("Background agent work") < workspace.indexOf("Call captions"));
  assert.match(workspace, /Continues after the call/);
  assert.match(workspace, /Drafts and results appear here while you keep talking/);
  assert.match(workspace, /Approve/);
  assert.match(workspace, /Reject/);
  assert.match(workspace, /Continues after you leave this chat/);
});

test("cancelling durable work needs a deliberate second action", () => {
  assert.match(workspace, /Stop this task\?/);
  assert.match(workspace, />\s*Keep working\s*<\/button>/);
  assert.match(workspace, />\s*Stop task\s*<\/button>/);
  assert.doesNotMatch(workspace, /onClick=\{\(\) => onAction\(task\.id, "cancel"\)\}/);
});

test("mobile agent work stays contained and the composer does not trigger iPhone zoom", () => {
  assert.match(workspace, /max-w-full flex-1 flex-col overflow-x-hidden/);
  assert.match(workspace, /Show \$\{visibleAgentTasks\.length - 1\} more/);
  assert.match(workspace, /text-\[16px\].*md:text-body/);
  assert.match(workspace, /function artifactContent/);
  assert.doesNotMatch(workspace, /JSON\.stringify\(content, null, 2\)/);
});

test("background work has separate workers, sessions and stronger model routing", () => {
  assert.match(bridge, /def build_task_workers/);
  assert.match(bridge, /reslu-task-\{task_id\}/);
  assert.match(bridge, /openai\/gpt-5\.6-sol/);
  assert.match(bridge, /delegate independent parts to available specialist or subagent tools/i);
  assert.match(bridge, /do not send external messages, make bookings, spend money, delete data/i);
});

test("the hosted database verifier exercises real rows and rolls back", () => {
  assert.match(verifier, /do \$verify\$/);
  assert.match(verifier, /claim_agent_task\(v_agent_slug\)/);
  assert.match(verifier, /decide_agent_task_artifact/);
  assert.match(verifier, /when sqlstate 'P5099'/);
  assert.match(verifier, /all test changes rolled back/);
  assert.doesNotMatch(verifier, /create temporary table/i);
});
