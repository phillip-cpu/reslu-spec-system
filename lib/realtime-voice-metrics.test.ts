import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealtimeVoiceLatencyMetadata,
  millisecondsBetween,
  sanitizeRealtimeVoiceMetrics,
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

test("database timestamps become non-negative bounded millisecond durations", () => {
  assert.equal(millisecondsBetween("2026-08-09T14:06:07.625Z", "2026-08-09T14:06:08.936Z"), 1311);
  assert.equal(millisecondsBetween("invalid", "2026-08-09T14:06:08.936Z"), null);
  assert.equal(millisecondsBetween("2026-08-09T14:06:08.936Z", "2026-08-09T14:06:07.625Z"), null);
});
