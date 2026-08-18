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
const progress = read("lib/realtime-progress.ts");
const consultPoll = read("lib/realtime-consult-poll.ts");
const nativeContinuity = read("lib/native-voice-continuity.ts");

test("realtime calls measure actual WebRTC output audio instead of transcript timing", () => {
  assert.match(workspace, /output_audio_buffer\.started/);
  assert.match(workspace, /response\.output_audio\.delta/);
  assert.match(workspace, /speech_to_ack_ms/);
  assert.match(workspace, /speech_to_first_audio_ms/);
  assert.match(workspace, /response_to_first_audio_ms/);
  assert.match(workspace, /output_audio_buffer\.cleared/);
  assert.match(workspace, /interruption_to_buffer_cleared_ms/);
});

test("speech stop stays visual while an accepted consult starts one bounded acknowledgement", () => {
  assert.match(workspace, /input_audio_buffer\.speech_stopped/);
  assert.match(workspace, /setCallState\("thinking"\)/);
  const speechStopHandler = workspace.match(/if \(event\.type === "input_audio_buffer\.speech_stopped"\) \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  assert.doesNotMatch(speechStopHandler, /response\.create|startRealtimeProgressCue/);
  assert.match(workspace, /if \(!start\.ok\) throw[\s\S]*?startRealtimeProgressCue\(toolCallId\);/);
  const completedResponseHandler = workspace.match(/if \(event\.type === "response\.done"[\s\S]*?return;\n    \}/)?.[0] ?? "";
  assert.doesNotMatch(completedResponseHandler, /startRealtimeProgressCue/);
  assert.match(workspace, /reslu_kind: REALTIME_PROGRESS_KIND/);
  assert.match(workspace, /realtimeProgressAcknowledgement\(callAgent\.agent_slug, timing\.turn\)/);
  assert.doesNotMatch(workspace, /buildRealtimeProgressResponse/);
  assert.doesNotMatch(progress, /checking/i);
  assert.match(workspace, /activeRealtimeConsultRef\.current \? "thinking" : "listening"/);
});

test("progress audio is independently cancellable and excluded from the transcript", () => {
  assert.match(workspace, /type: "response\.cancel", response_id: cue\.responseId/);
  assert.match(workspace, /realtimeProgressResponseCueIdsRef\.current\.has\(responseId\)/);
  assert.match(workspace, /realtimeProgressCueId\(event\.response\)/);
});

test("consult timing separates queue wait, agent processing and backend total", () => {
  assert.match(consultRoute, /created_at,claimed_at,completed_at/);
  assert.match(consultRoute, /queue_wait_ms: millisecondsBetween/);
  assert.match(consultRoute, /agent_processing_ms: millisecondsBetween/);
  assert.match(consultRoute, /backend_total_ms: millisecondsBetween/);
  assert.match(workspace, /consult_round_trip_ms/);
  assert.match(workspace, /realtimeConsultPollDelay\(elapsedMs\)/);
  assert.match(consultPoll, /elapsedMs < 5_000[\s\S]*return 250/);
  assert.match(consultPoll, /elapsedMs < 15_000[\s\S]*return 500[\s\S]*return 1_000/);
});

test("call records retain bounded timing metadata without transcript or provider identifiers", () => {
  assert.match(callsRoute, /buildRealtimeVoiceLatencyMetadata/);
  assert.match(callsRoute, /p_voice_latency: voiceLatency/);
  assert.match(metrics, /MAX_REALTIME_VOICE_METRICS = 20/);
  assert.match(metrics, /average_interruption_clear_ms/);
  assert.doesNotMatch(metrics, /transcript:/);
  assert.doesNotMatch(metrics, /tool_call_id:/);
  assert.match(callsRoute, /sanitizeNativeVoiceContinuity/);
  assert.match(callsRoute, /continuityToRecord/);
  assert.match(nativeContinuity, /peak_buffered_web_events/);
  assert.doesNotMatch(nativeContinuity, /transcript:/);
});

test("browser and native Realtime calls retain content-free model usage from provider completion events", () => {
  assert.match(workspace, /event\.response\?\.usage/);
  assert.match(workspace, /event\.usage/);
  assert.match(workspace, /realtimeVoiceUsageSnapshot/);
  assert.match(metrics, /openai_realtime_response_done_client_observed/);
  assert.match(metrics, /input_audio_tokens/);
  assert.match(metrics, /output_audio_tokens/);
  assert.match(metrics, /cached_tokens/);
});

test("the spoken response is requested before refreshing canonical messages", () => {
  assert.match(workspace, /void loadMessages\(selectedId\)/);
  assert.ok(workspace.indexOf("void loadMessages(selectedId)") < workspace.indexOf('type: "response.create"'));
});
