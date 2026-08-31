import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("Realtime voice and standard chat use disjoint atomic queue claims", () => {
  const migration = read("supabase/migrations/20260818185512_realtime_voice_priority_lane.sql");
  assert.match(migration, /claim_agent_realtime_voice_job/);
  assert.match(migration, /source' = 'voice'/);
  assert.match(migration, /transport' = 'openai_realtime_webrtc'/);
  assert.match(migration, /and not \([\s\S]*source' = 'voice'[\s\S]*transport' = 'openai_realtime_webrtc'/);
  assert.match(migration, /for update of candidate skip locked/gi);
  assert.match(migration, /revoke all on function claim_agent_realtime_voice_job\(text\)[\s\S]*authenticated/i);
  assert.match(migration, /grant execute on function claim_agent_realtime_voice_job\(text\)[\s\S]*service_role/i);
});

test("the bridge has one monitored voice worker per canonical agent", () => {
  const bridge = read("scripts/conversation_agent_bridge.py");
  for (const slug of ["aria", "marco", "stuart"]) {
    assert.match(bridge, new RegExp(`reslu-voice-${slug}`));
  }
  assert.match(bridge, /def claim_voice/);
  assert.match(bridge, /rpc\/claim_agent_realtime_voice_job/);
  assert.match(bridge, /def build_voice_workers/);
  assert.match(bridge, /openclaw_voice_session_key/);
  assert.match(bridge, /\*build_voice_workers\(base_url, service_key\)/);
});

test("Health exposes a missing Realtime voice priority-lane capability", () => {
  const health = read("lib/health.ts");
  assert.match(health, /key: "realtime_voice_priority_lane"/);
  assert.match(health, /rpc: "claim_agent_realtime_voice_job"/);
  assert.match(health, /p_agent_slug: "__health_probe__"/);
});

test("the production verifier proves lane separation and rolls back", () => {
  const fixture = read("supabase/fixtures/20260818185512_realtime_voice_priority_lane_verify.sql");
  assert.match(fixture, /has_function_privilege\('anon'/);
  assert.match(fixture, /claim_agent_realtime_voice_job\(v_agent_slug\)/);
  assert.match(fixture, /claim_agent_conversation_job\(v_agent_slug\)/);
  assert.match(fixture, /voice and standard claims were not disjoint/i);
  assert.match(fixture, /all test changes rolled back/i);
});
