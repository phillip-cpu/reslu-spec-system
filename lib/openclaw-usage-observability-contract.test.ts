import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20260819093000_openclaw_runtime_usage.sql");
const verifier = read("supabase/fixtures/20260819093000_openclaw_runtime_usage_verify.sql");
const helper = read("scripts/openclaw_gateway_run.mjs");
const bridge = read("scripts/conversation_agent_bridge.py");
const health = read("lib/health.ts");
const card = read("components/health/SpecHealthCard.tsx");

test("OpenClaw usage schema is bounded and attached to turns and tasks", () => {
  assert.match(migration, /create or replace function public\.is_valid_openclaw_usage/i);
  assert.match(migration, /agent_conversation_jobs[\s\S]*openclaw_usage/i);
  assert.match(migration, /agent_tasks[\s\S]*openclaw_usage/i);
  assert.match(migration, /count\(\*\) = 9 from jsonb_object_keys/i);
  assert.match(verifier, /arbitrary content was accepted/i);
});

test("Gateway and bridge persist only sanitized final usage", () => {
  assert.match(helper, /safeOpenClawUsage\(payload\.message\)/);
  assert.match(helper, /schema_version:\s*1[\s\S]*input_tokens[\s\S]*cost_usd/);
  assert.doesNotMatch(helper.match(/export function safeOpenClawUsage[\s\S]*?\n}\n/)?.[0] ?? "", /prompt|reply|reasoning|tool/i);
  assert.match(bridge, /bounded_openclaw_usage[\s\S]*openclaw_usage/);
});

test("Health reports exact OpenClaw model usage without content", () => {
  assert.match(health, /agent_conversation_jobs[\s\S]*select\("openclaw_usage"\)/);
  assert.match(health, /agent_tasks[\s\S]*select\("openclaw_usage"\)/);
  assert.match(card, /OpenClaw agent usage · last 7 days/);
  assert.match(card, /No transcript, prompt, reply, reasoning, file or tool argument is stored/);
});
