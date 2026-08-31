import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationCapabilityUnavailable,
  conversationTaskTransportHasIncident,
  conversationTransportHasIncident,
  conversationTransportLevel,
  conversationTurnTransportHasIncident,
  sanitizeOpenClawUsage,
  summarizeConversationVoiceHealth,
  summarizeOpenClawUsage,
} from "./conversation-health.ts";

const healthy = {
  query_errors: 0,
  unavailable_capabilities: [],
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
  voice_usage_calls_observed: 0,
  voice_usage_truncated: false,
  realtime_usage_by_model: [],
  transcription_usage_by_model: [],
  openclaw_usage_runs_observed: 0,
  openclaw_usage_truncated: false,
  openclaw_usage_by_model: [],
};

test("voice health retains only bounded timing aggregates", () => {
  assert.deepEqual(summarizeConversationVoiceHealth([
    { realtime_voice_latency: { turns: [
      { turn: 1, outcome: "spoken", speech_to_ack_ms: 800, interruption_to_buffer_cleared_ms: 120, transcript: "private" },
      { turn: 2, outcome: "spoken", speech_to_ack_ms: 1200, interruption_to_buffer_cleared_ms: 180, provider_id: "secret" },
    ], usage: {
      realtime_model: "gpt-realtime-2.1",
      transcription_model: "gpt-live-transcribe",
      responses: { count: 2, total_tokens: 500, input_tokens: 350, output_tokens: 150, input_audio_tokens: 40, output_audio_tokens: 100, cached_tokens: 200 },
      transcriptions: { count: 2, total_tokens: 50, input_tokens: 30, output_tokens: 20, input_audio_tokens: 30, seconds: 0 },
    } } },
    { realtime_voice_latency: null },
  ]), {
    voice_calls_observed: 1,
    voice_turns_observed: 2,
    average_acknowledgement_ms: 1000,
    slowest_interruption_clear_ms: 180,
    voice_usage_calls_observed: 1,
    voice_usage_truncated: false,
    realtime_usage_by_model: [{
      model: "gpt-realtime-2.1",
      calls: 1,
      responses: 2,
      total_tokens: 500,
      input_tokens: 350,
      output_tokens: 150,
      input_audio_tokens: 40,
      output_audio_tokens: 100,
      cached_tokens: 200,
    }],
    transcription_usage_by_model: [{
      model: "gpt-live-transcribe",
      calls: 1,
      transcriptions: 2,
      total_tokens: 50,
      input_tokens: 30,
      output_tokens: 20,
      input_audio_tokens: 30,
      seconds: 0,
    }],
  });
});

test("voice usage rolls up separately by exact model and declares a capped period", () => {
  const result = summarizeConversationVoiceHealth([
    { realtime_voice_latency: { usage: {
      realtime_model: "gpt-realtime-2.1",
      transcription_model: "gpt-live-transcribe",
      responses: { count: 1, total_tokens: 100, input_tokens: 80, output_tokens: 20 },
      transcriptions: { count: 1, total_tokens: 12, input_tokens: 8, output_tokens: 4 },
    } } },
    { realtime_voice_latency: { usage: {
      realtime_model: "gpt-realtime-2.1-mini",
      transcription_model: "gpt-live-transcribe",
      responses: { count: 1, total_tokens: 40, input_tokens: 30, output_tokens: 10 },
      transcriptions: { count: 1, total_tokens: 8, input_tokens: 6, output_tokens: 2 },
    } } },
  ], true);
  assert.equal(result.voice_usage_calls_observed, 2);
  assert.equal(result.voice_usage_truncated, true);
  assert.deepEqual(result.realtime_usage_by_model.map((entry) => [entry.model, entry.total_tokens]), [
    ["gpt-realtime-2.1", 100],
    ["gpt-realtime-2.1-mini", 40],
  ]);
  assert.deepEqual(result.transcription_usage_by_model.map((entry) => [entry.model, entry.total_tokens]), [
    ["gpt-live-transcribe", 20],
  ]);
});

test("OpenClaw usage is content-free, bounded and grouped by exact runtime model", () => {
  const first = {
    schema_version: 1,
    provider: "openai",
    model: "gpt-5.6-terra",
    input_tokens: 100,
    output_tokens: 5,
    cache_read_tokens: 20,
    cache_write_tokens: 0,
    total_tokens: 125,
    cost_usd: 0.001,
  };
  assert.equal(sanitizeOpenClawUsage({ ...first, prompt: "private" }), null);
  assert.equal(sanitizeOpenClawUsage({ ...first, total_tokens: -1 }), null);
  assert.deepEqual(summarizeOpenClawUsage([
    { openclaw_usage: first },
    { openclaw_usage: { ...first, input_tokens: 50, output_tokens: 10, total_tokens: 80, cost_usd: 0.002 } },
    { openclaw_usage: { ...first, model: "gpt-5.6-sol", input_tokens: 40, total_tokens: 65 } },
  ], true), {
    openclaw_usage_runs_observed: 3,
    openclaw_usage_truncated: true,
    openclaw_usage_by_model: [
      {
        provider: "openai", model: "gpt-5.6-terra", runs: 2, total_tokens: 205,
        input_tokens: 150, output_tokens: 15, cache_read_tokens: 40, cache_write_tokens: 0,
        reported_cost_usd: 0.003,
      },
      {
        provider: "openai", model: "gpt-5.6-sol", runs: 1, total_tokens: 65,
        input_tokens: 40, output_tokens: 5, cache_read_tokens: 20, cache_write_tokens: 0,
        reported_cost_usd: 0.001,
      },
    ],
  });
});

test("operational failures are incidents while latency misses are warnings", () => {
  assert.equal(conversationTransportHasIncident(healthy), false);
  assert.equal(conversationTransportLevel(healthy), "green");
  assert.equal(conversationTransportLevel({ ...healthy, average_acknowledgement_ms: 1001 }), "amber");
  assert.equal(conversationTransportLevel({ ...healthy, slowest_interruption_clear_ms: 251 }), "amber");
  assert.equal(conversationTransportLevel({ ...healthy, processing_jobs_stuck: 1 }), "red");
  assert.equal(conversationTransportHasIncident({ ...healthy, failed_tasks_24h: 1 }), true);
  assert.equal(conversationTransportHasIncident({ ...healthy, unavailable_capabilities: ["message_forwarding"] }), true);
});

test("durable task incidents open and recover independently from chat transport", () => {
  const failedTask = { ...healthy, failed_tasks_24h: 1 };
  const failedTurn = { ...healthy, failed_jobs_24h: 1 };

  assert.equal(conversationTaskTransportHasIncident(failedTask), true);
  assert.equal(conversationTurnTransportHasIncident(failedTask), false);
  assert.equal(conversationTransportHasIncident(failedTask), true);

  assert.equal(conversationTaskTransportHasIncident(failedTurn), false);
  assert.equal(conversationTurnTransportHasIncident(failedTurn), true);
  assert.equal(conversationTransportHasIncident(failedTurn), true);
});

test("schema capability probes distinguish missing RPCs from their safe argument guard", () => {
  assert.equal(conversationCapabilityUnavailable({ code: "PGRST202", message: "Could not find the function" }), true);
  assert.equal(conversationCapabilityUnavailable({ code: "42501", message: "permission denied for function" }), true);
  assert.equal(conversationCapabilityUnavailable({ code: "P0001", message: "unauthorized" }), false);
});
