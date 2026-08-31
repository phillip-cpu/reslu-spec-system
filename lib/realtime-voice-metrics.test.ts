import assert from "node:assert/strict";
import test from "node:test";
import {
  addRealtimeResponseUsage,
  addRealtimeTranscriptionUsage,
  buildRealtimeVoiceLatencyMetadata,
  createRealtimeVoiceUsageAccumulator,
  millisecondsBetween,
  realtimeVoiceUsageSnapshot,
  sanitizeRealtimeVoiceMetrics,
  setRealtimeVoiceUsageModels,
} from "./realtime-voice-metrics.ts";

test("voice latency metrics retain bounded durations and discard identifiers or transcript data", () => {
  assert.deepEqual(sanitizeRealtimeVoiceMetrics([{
    turn: 1,
    outcome: "spoken",
    speech_to_tool_ms: 120.4,
    queue_wait_ms: 37_700,
    agent_processing_ms: 35_300,
    interruption_to_mute_ms: 4.4,
    interruption_to_buffer_cleared_ms: 81.6,
    transcript: "private words",
    tool_call_id: "provider-secret",
    backend_total_ms: Number.POSITIVE_INFINITY,
  }]), [{
    turn: 1,
    outcome: "spoken",
    speech_to_tool_ms: 120,
    queue_wait_ms: 37_700,
    agent_processing_ms: 35_300,
    interruption_to_mute_ms: 4,
    interruption_to_buffer_cleared_ms: 82,
  }]);
});

test("voice latency metadata summarizes only the sanitized turn timings", () => {
  const metadata = buildRealtimeVoiceLatencyMetadata([
    { turn: 1, outcome: "spoken", speech_to_ack_ms: 900, queue_wait_ms: 1000, agent_processing_ms: 3000, speech_to_first_audio_ms: 5000, interruption_to_buffer_cleared_ms: 80 },
    { turn: 2, outcome: "spoken", speech_to_ack_ms: 1100, queue_wait_ms: 3000, agent_processing_ms: 5000, speech_to_first_audio_ms: 9000, interruption_to_buffer_cleared_ms: 120 },
    { turn: 3, outcome: "cancelled", speech_to_tool_ms: 250 },
  ]);
  assert.deepEqual(metadata?.summary, {
    observed_turns: 3,
    spoken_turns: 2,
    average_acknowledgement_ms: 1000,
    average_queue_wait_ms: 2000,
    average_agent_processing_ms: 4000,
    average_total_turn_ms: 7000,
    slowest_total_turn_ms: 9000,
    observed_interruptions: 2,
    average_interruption_clear_ms: 100,
    slowest_interruption_clear_ms: 120,
  });
});

test("Realtime response.done and transcription usage become bounded content-free call totals", () => {
  const usage = createRealtimeVoiceUsageAccumulator();
  setRealtimeVoiceUsageModels(usage, "gpt-realtime-2.1", "gpt-live-transcribe");
  addRealtimeResponseUsage(usage, {
    total_tokens: 253,
    input_tokens: 132,
    output_tokens: 121,
    input_token_details: {
      text_tokens: 119,
      audio_tokens: 13,
      image_tokens: 0,
      cached_tokens: 64,
      transcript: "must not survive",
    },
    output_token_details: { text_tokens: 30, audio_tokens: 91 },
    response_id: "must-not-survive",
  });
  addRealtimeTranscriptionUsage(usage, {
    type: "tokens",
    total_tokens: 26,
    input_tokens: 17,
    output_tokens: 9,
    input_token_details: { text_tokens: 0, audio_tokens: 17 },
    transcript: "private words",
  });
  const snapshot = realtimeVoiceUsageSnapshot(usage);
  assert.deepEqual(snapshot, {
    schema_version: 1,
    source: "openai_realtime_response_done_client_observed",
    realtime_model: "gpt-realtime-2.1",
    transcription_model: "gpt-live-transcribe",
    responses: {
      count: 1,
      total_tokens: 253,
      input_tokens: 132,
      output_tokens: 121,
      input_text_tokens: 119,
      input_audio_tokens: 13,
      input_image_tokens: 0,
      cached_tokens: 64,
      output_text_tokens: 30,
      output_audio_tokens: 91,
    },
    transcriptions: {
      count: 1,
      total_tokens: 26,
      input_tokens: 17,
      output_tokens: 9,
      input_text_tokens: 0,
      input_audio_tokens: 17,
      seconds: 0,
    },
  });
  const metadata = buildRealtimeVoiceLatencyMetadata({ turns: [], usage: snapshot });
  assert.equal(metadata?.schema_version, 2);
  assert.deepEqual(metadata?.usage, snapshot);
  assert.equal(JSON.stringify(metadata).includes("private words"), false);
  assert.equal(JSON.stringify(metadata).includes("response_id"), false);
});

test("usage sanitizer rejects arbitrary model labels and out-of-range token claims", () => {
  const metadata = buildRealtimeVoiceLatencyMetadata({
    turns: [],
    usage: {
      realtime_model: "bad model<script>",
      transcription_model: "gpt-live-transcribe",
      responses: { count: 1, total_tokens: Number.MAX_SAFE_INTEGER, input_tokens: -1, output_tokens: 5 },
      transcriptions: { count: 0 },
    },
  });
  assert.equal(metadata?.usage?.realtime_model, null);
  assert.equal(metadata?.usage?.transcription_model, "gpt-live-transcribe");
  assert.equal(metadata?.usage?.responses.total_tokens, 0);
  assert.equal(metadata?.usage?.responses.input_tokens, 0);
  assert.equal(metadata?.usage?.responses.output_tokens, 5);
});

test("database timestamps become non-negative bounded millisecond durations", () => {
  assert.equal(millisecondsBetween("2026-08-09T14:06:07.625Z", "2026-08-09T14:06:08.936Z"), 1311);
  assert.equal(millisecondsBetween("invalid", "2026-08-09T14:06:08.936Z"), null);
  assert.equal(millisecondsBetween("2026-08-09T14:06:08.936Z", "2026-08-09T14:06:07.625Z"), null);
});
