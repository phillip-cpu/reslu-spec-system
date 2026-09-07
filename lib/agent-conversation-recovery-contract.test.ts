import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260907054932_agent_conversation_recovery.sql", "utf8");
const bridge = readFileSync("scripts/conversation_agent_bridge.py", "utf8");
const gateway = readFileSync("scripts/openclaw_gateway_run.mjs", "utf8");
const consultRoute = readFileSync("app/api/conversations/[id]/realtime/consult/route.ts", "utf8");
const taskRoute = readFileSync("app/api/conversations/[id]/realtime/task/route.ts", "utf8");
const workspace = readFileSync("components/conversations/ConversationWorkspace.tsx", "utf8");

test("voice interruption cancels only prior voice jobs", () => {
  assert.match(migration, /cancel_realtime_voice_agent_jobs/);
  assert.match(migration, /message\.metadata->>'source' = 'voice'/);
  assert.doesNotMatch(consultRoute, /rpc\("cancel_agent_conversation_jobs"/);
});

test("typed turns use adaptive reasoning, tail-preserving context and rolling checkpoints", () => {
  assert.match(bridge, /TEXT_CHAT_THINKING_LEVEL = "medium"/);
  assert.match(bridge, /def conversation_thinking_level\(/);
  assert.match(bridge, /def bounded_transcript_json\(/);
  assert.match(bridge, /def refresh_conversation_context_summary\(/);
  assert.match(bridge, /openclaw_conversation_turn_session_key/);
});

test("late task steering creates another bounded pass instead of being silently ignored", () => {
  assert.match(migration, /steering_version integer not null default 0/);
  assert.match(migration, /record_agent_task_steering/);
  assert.match(bridge, /Applying your latest direction/);
  assert.match(bridge, /Latest direction queued for a fresh pass/);
});

test("agent completion and failures are visible and transactionally settled", () => {
  assert.match(migration, /complete_agent_conversation_job/);
  assert.match(migration, /fail_agent_conversation_job/);
  assert.match(bridge, /rest\.complete_conversation_job\(/);
  assert.match(bridge, /rest\.fail_conversation_job\(/);
  assert.match(bridge, /completion_state": "unverified"/);
});

test("progress, attempts and explicit outcomes are measurable", () => {
  assert.match(gateway, /delta: data\.delta\.slice\(0, 1200\)/);
  assert.match(migration, /create table if not exists public\.agent_run_attempts/);
  assert.match(migration, /create table if not exists public\.agent_outcome_feedback/);
  assert.match(migration, /enable row level security/);
  assert.match(workspace, />Outcome</);
});

test("voice stores the provider transcript while preserving the normalized intent", () => {
  assert.match(consultRoute, /normalized_query: body\.query/);
  assert.match(consultRoute, /body: body\.exactTranscript/);
  assert.match(taskRoute, /normalized_objective: body\.objective/);
  assert.match(taskRoute, /body: body\.exactTranscript/);
  assert.match(workspace, /latestInputTranscriptRef\.current \|\| query/);
});
