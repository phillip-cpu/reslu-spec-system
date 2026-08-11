import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationTransportHasIncident,
  conversationTransportLevel,
  summarizeConversationVoiceHealth,
} from "./conversation-health.ts";

const healthy = {
  query_errors: 0,
  pending_jobs: 0,
  oldest_pending_job_ms: null,
  processing_jobs_stuck: 0,
  failed_jobs_24h: 0,
  queued_tasks: 0,
  running_tasks_stuck: 0,
  failed_tasks_24h: 0,
  active_calls_stale: 0,
  voice_calls_observed: 1,
  voice_turns_observed: 1,
  average_acknowledgement_ms: 800,
  slowest_interruption_clear_ms: 120,
};

test("voice health retains only bounded timing aggregates", () => {
  assert.deepEqual(summarizeConversationVoiceHealth([
    { realtime_voice_latency: { turns: [
      { turn: 1, outcome: "spoken", speech_to_ack_ms: 800, interruption_to_buffer_cleared_ms: 120, transcript: "private" },
      { turn: 2, outcome: "spoken", speech_to_ack_ms: 1200, interruption_to_buffer_cleared_ms: 180, provider_id: "secret" },
    ] } },
    { realtime_voice_latency: null },
  ]), {
    voice_calls_observed: 1,
    voice_turns_observed: 2,
    average_acknowledgement_ms: 1000,
    slowest_interruption_clear_ms: 180,
  });
});

test("operational failures are incidents while latency misses are warnings", () => {
  assert.equal(conversationTransportHasIncident(healthy), false);
  assert.equal(conversationTransportLevel(healthy), "green");
  assert.equal(conversationTransportLevel({ ...healthy, average_acknowledgement_ms: 1001 }), "amber");
  assert.equal(conversationTransportLevel({ ...healthy, slowest_interruption_clear_ms: 251 }), "amber");
  assert.equal(conversationTransportLevel({ ...healthy, processing_jobs_stuck: 1 }), "red");
  assert.equal(conversationTransportHasIncident({ ...healthy, failed_tasks_24h: 1 }), true);
});
