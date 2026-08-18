import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/100_openclaw_gateway_progress.sql");
const fixture = read("supabase/fixtures/100_openclaw_gateway_progress_verify.sql");
const gateway = read("scripts/openclaw_gateway_run.mjs");
const bridge = read("scripts/conversation_agent_bridge.py");
const route = read("app/api/conversations/[id]/messages/route.ts");

test("Gateway progress columns are bounded and retain existing member RLS", () => {
  assert.match(migration, /agent_conversation_jobs[\s\S]*gateway_run_id[\s\S]*progress_label[\s\S]*progress_updated_at/i);
  assert.match(migration, /agent_tasks[\s\S]*gateway_run_id[\s\S]*progress_label[\s\S]*progress_updated_at/i);
  assert.match(migration, /char_length\(progress_label\) between 1 and 240/i);
  assert.match(fixture, /members_read_agent_jobs/);
  assert.match(fixture, /members_read_agent_tasks/);
  assert.match(fixture, /rollback;/i);
});

test("the bridge uses a loopback authenticated Gateway run with stable identity", () => {
  assert.match(gateway, /\["127\.0\.0\.1", "localhost", "::1"\]/);
  assert.match(gateway, /method: "connect"|request\("connect"/);
  assert.match(gateway, /idempotencyKey: input\.idempotencyKey/);
  assert.match(gateway, /sessionKey: input\.sessionKey/);
  assert.match(gateway, /request\("chat\.abort"/);
  assert.match(bridge, /idempotency_key=job\["id"\]/);
  assert.match(bridge, /openclaw_session_key\(conversation_id\)/);
  assert.match(bridge, /openclaw_voice_session_key\(job\["conversation_id"\], realtime_call_id\)/);
  assert.match(bridge, /reslu-call-v1-/);
});

test("member-visible activity exposes labels but no tool arguments or results", () => {
  assert.match(route, /progress_label,progress_updated_at/);
  assert.doesNotMatch(route, /gateway_run_id/);
  assert.match(bridge, /Persist bounded metadata-only progress without storing tool arguments/);
  assert.doesNotMatch(gateway.match(/function safeAgentEvent[\s\S]*?\n}/)?.[0] ?? "", /args:|result:/);
});

test("an accepted run never falls back and duplicate-executes through the CLI", () => {
  assert.match(bridge, /if exc\.accepted:\n\s+raise/);
  assert.match(bridge, /Gateway unavailable before acceptance; using CLI fallback/);
});
