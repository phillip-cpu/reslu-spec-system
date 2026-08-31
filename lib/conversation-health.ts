import { sanitizeRealtimeVoiceMetrics, sanitizeRealtimeVoiceUsage } from "./realtime-voice-metrics.ts";
import type { ConversationTransportHealth, HealthPillLevel } from "../types/health-push.ts";

export const CONVERSATION_PENDING_WARNING_MS = 2 * 60 * 1000;
export const CONVERSATION_PENDING_INCIDENT_MS = 5 * 60 * 1000;
export const VOICE_ACK_TARGET_MS = 1000;
export const VOICE_INTERRUPTION_TARGET_MS = 250;

type CallLatencyRow = { realtime_voice_latency?: unknown };
type OpenClawUsageRow = { openclaw_usage?: unknown };

type ConversationCapabilityProbeError = { code?: string | null; message?: string | null } | null;

export function conversationCapabilityUnavailable(error: ConversationCapabilityProbeError) {
  if (!error) return false;
  const code = error.code ?? "";
  const message = error.message ?? "";
  return ["PGRST202", "42883", "42501"].includes(code)
    || /could not find the function|function .* does not exist|permission denied for function/i.test(message);
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function boundedUsageInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : null;
}

export function sanitizeOpenClawUsage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const keys = Object.keys(usage).sort();
  const expected = [
    "cache_read_tokens", "cache_write_tokens", "cost_usd", "input_tokens", "model",
    "output_tokens", "provider", "schema_version", "total_tokens",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  const provider = typeof usage.provider === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(usage.provider)
    ? usage.provider
    : null;
  const model = typeof usage.model === "string" && /^[A-Za-z0-9._:/-]{1,160}$/.test(usage.model)
    ? usage.model
    : null;
  if (usage.schema_version !== 1 || !provider || !model) return null;
  const inputTokens = boundedUsageInteger(usage.input_tokens);
  const outputTokens = boundedUsageInteger(usage.output_tokens);
  const cacheReadTokens = boundedUsageInteger(usage.cache_read_tokens);
  const cacheWriteTokens = boundedUsageInteger(usage.cache_write_tokens);
  const totalTokens = boundedUsageInteger(usage.total_tokens);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens].includes(null)) return null;
  const costUsd = usage.cost_usd === null
    ? 0
    : typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0 && usage.cost_usd <= 1_000_000
      ? usage.cost_usd
      : null;
  if (costUsd === null) return null;
  return {
    provider,
    model,
    input_tokens: inputTokens!,
    output_tokens: outputTokens!,
    cache_read_tokens: cacheReadTokens!,
    cache_write_tokens: cacheWriteTokens!,
    total_tokens: totalTokens!,
    cost_usd: costUsd,
  };
}

/** Content-free aggregate over bounded OpenClaw usage captured per completed run. */
export function summarizeOpenClawUsage(rows: OpenClawUsageRow[], truncated = false) {
  const byModel = new Map<string, ConversationTransportHealth["openclaw_usage_by_model"][number]>();
  let observed = 0;
  for (const row of rows) {
    const usage = sanitizeOpenClawUsage(row.openclaw_usage);
    if (!usage) continue;
    observed += 1;
    const key = `${usage.provider}/${usage.model}`;
    const current = byModel.get(key) ?? {
      provider: usage.provider,
      model: usage.model,
      runs: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reported_cost_usd: 0,
    };
    current.runs += 1;
    current.total_tokens += usage.total_tokens;
    current.input_tokens += usage.input_tokens;
    current.output_tokens += usage.output_tokens;
    current.cache_read_tokens += usage.cache_read_tokens;
    current.cache_write_tokens += usage.cache_write_tokens;
    current.reported_cost_usd = Math.round((current.reported_cost_usd + usage.cost_usd) * 100_000_000) / 100_000_000;
    byModel.set(key, current);
  }
  return {
    openclaw_usage_runs_observed: observed,
    openclaw_usage_truncated: truncated,
    openclaw_usage_by_model: [...byModel.values()].sort((left, right) => right.total_tokens - left.total_tokens),
  };
}

/** Content-free aggregate over the already-sanitized per-call timing payload. */
export function summarizeConversationVoiceHealth(calls: CallLatencyRow[], usageTruncated = false) {
  const callMetrics = calls.map((call) => {
    const latency = call.realtime_voice_latency;
    if (!latency || typeof latency !== "object" || Array.isArray(latency)) return [];
    return sanitizeRealtimeVoiceMetrics((latency as Record<string, unknown>).turns);
  });
  const turns = callMetrics.flat();
  const acknowledgements = turns.flatMap((turn) => typeof turn.speech_to_ack_ms === "number" ? [turn.speech_to_ack_ms] : []);
  const interruptions = turns.flatMap((turn) => typeof turn.interruption_to_buffer_cleared_ms === "number"
    ? [turn.interruption_to_buffer_cleared_ms]
    : []);
  const usageCalls = calls.flatMap((call) => {
    const latency = call.realtime_voice_latency;
    if (!latency || typeof latency !== "object" || Array.isArray(latency)) return [];
    const usage = sanitizeRealtimeVoiceUsage((latency as Record<string, unknown>).usage);
    return usage ? [usage] : [];
  });
  const realtimeByModel = new Map<string, ConversationTransportHealth["realtime_usage_by_model"][number]>();
  const transcriptionByModel = new Map<string, ConversationTransportHealth["transcription_usage_by_model"][number]>();
  for (const usage of usageCalls) {
    if (usage.responses.count > 0) {
      const model = usage.realtime_model ?? "Unknown Realtime model";
      const current = realtimeByModel.get(model) ?? {
        model, calls: 0, responses: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0,
        input_audio_tokens: 0, output_audio_tokens: 0, cached_tokens: 0,
      };
      current.calls += 1;
      current.responses += usage.responses.count;
      current.total_tokens += usage.responses.total_tokens;
      current.input_tokens += usage.responses.input_tokens;
      current.output_tokens += usage.responses.output_tokens;
      current.input_audio_tokens += usage.responses.input_audio_tokens;
      current.output_audio_tokens += usage.responses.output_audio_tokens;
      current.cached_tokens += usage.responses.cached_tokens;
      realtimeByModel.set(model, current);
    }
    if (usage.transcriptions.count > 0) {
      const model = usage.transcription_model ?? "Unknown transcription model";
      const current = transcriptionByModel.get(model) ?? {
        model, calls: 0, transcriptions: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0,
        input_audio_tokens: 0, seconds: 0,
      };
      current.calls += 1;
      current.transcriptions += usage.transcriptions.count;
      current.total_tokens += usage.transcriptions.total_tokens;
      current.input_tokens += usage.transcriptions.input_tokens;
      current.output_tokens += usage.transcriptions.output_tokens;
      current.input_audio_tokens += usage.transcriptions.input_audio_tokens;
      current.seconds = Math.round((current.seconds + usage.transcriptions.seconds) * 1000) / 1000;
      transcriptionByModel.set(model, current);
    }
  }
  return {
    voice_calls_observed: callMetrics.filter((metrics) => metrics.length > 0).length,
    voice_turns_observed: turns.length,
    average_acknowledgement_ms: average(acknowledgements),
    slowest_interruption_clear_ms: interruptions.length > 0 ? Math.max(...interruptions) : null,
    voice_usage_calls_observed: usageCalls.length,
    voice_usage_truncated: usageTruncated,
    realtime_usage_by_model: [...realtimeByModel.values()].sort((left, right) => right.total_tokens - left.total_tokens),
    transcription_usage_by_model: [...transcriptionByModel.values()].sort((left, right) => right.total_tokens - left.total_tokens),
  };
}

export function conversationTransportHasIncident(health: Omit<ConversationTransportHealth, "level" | "operational_incident">) {
  return conversationTurnTransportHasIncident(health)
    || conversationTaskTransportHasIncident(health);
}

/**
 * Conversational transport failures share one lifecycle: queued/processing
 * turns, stale calls, missing capabilities and health-read failures. Durable
 * background work is intentionally excluded so it can alert and recover
 * independently without being masked by an unrelated failed chat turn.
 */
export function conversationTurnTransportHasIncident(
  health: Omit<ConversationTransportHealth, "level" | "operational_incident">
) {
  return health.query_errors > 0
    || health.unavailable_capabilities.length > 0
    || health.processing_jobs_stuck > 0
    || health.failed_jobs_24h > 0
    || health.active_calls_stale > 0
    || (health.oldest_pending_job_ms ?? 0) > CONVERSATION_PENDING_INCIDENT_MS;
}

/** Durable task dead letters/recovery have their own deduplicated incident. */
export function conversationTaskTransportHasIncident(
  health: Omit<ConversationTransportHealth, "level" | "operational_incident">
) {
  return health.running_tasks_stuck > 0 || health.failed_tasks_24h > 0;
}

export function conversationTransportLevel(
  health: Omit<ConversationTransportHealth, "level" | "operational_incident">
): HealthPillLevel {
  if (conversationTransportHasIncident(health)) return "red";
  if (
    (health.oldest_pending_job_ms ?? 0) > CONVERSATION_PENDING_WARNING_MS
    || (health.average_acknowledgement_ms ?? 0) > VOICE_ACK_TARGET_MS
    || (health.slowest_interruption_clear_ms ?? 0) > VOICE_INTERRUPTION_TARGET_MS
  ) return "amber";
  return "green";
}
