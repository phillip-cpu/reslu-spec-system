import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const consultRoute = read("app/api/conversations/[id]/realtime/consult/route.ts");
const callsRoute = read("app/api/conversations/[id]/calls/route.ts");
const metrics = read("lib/realtime-voice-metrics.ts");

test("realtime calls measure actual WebRTC output audio instead of transcript timing", () => {
  assert.match(workspace, /output_audio_buffer\.started/);
  assert.match(workspace, /response\.output_audio\.delta/);
  assert.match(workspace, /speech_to_ack_ms/);
  assert.match(workspace, /speech_to_first_audio_ms/);
  assert.match(workspace, /response_to_first_audio_ms/);
});

test("a slow substantive consult gets one bounded truthful spoken progress cue", () => {
  assert.match(workspace, /progressCuePlayed/);
  assert.match(workspace, /Say exactly: \"I’m checking that now\.\"/);
  assert.match(workspace, /tool_choice: "none"/);
  assert.match(workspace, /activeRealtimeConsultRef\.current \? "thinking" : "listening"/);
});

test("consult timing separates queue wait, agent processing and backend total", () => {
  assert.match(consultRoute, /created_at,claimed_at,completed_at/);
  assert.match(consultRoute, /queue_wait_ms: millisecondsBetween/);
  assert.match(consultRoute, /agent_processing_ms: millisecondsBetween/);
  assert.match(consultRoute, /backend_total_ms: millisecondsBetween/);
  assert.match(workspace, /consult_round_trip_ms/);
});

test("call records retain bounded timing metadata without transcript or provider identifiers", () => {
  assert.match(callsRoute, /buildRealtimeVoiceLatencyMetadata/);
  assert.match(callsRoute, /p_voice_latency: voiceLatency/);
  assert.match(metrics, /MAX_REALTIME_VOICE_METRICS = 20/);
  assert.doesNotMatch(metrics, /transcript:/);
  assert.doesNotMatch(metrics, /tool_call_id:/);
});

test("the spoken response is requested before refreshing canonical messages", () => {
  assert.match(workspace, /void loadMessages\(selectedId\)/);
  assert.ok(workspace.indexOf("void loadMessages(selectedId)") < workspace.indexOf('type: "response.create"'));
});
