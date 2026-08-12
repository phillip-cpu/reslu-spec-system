import { sanitizeRealtimeVoiceMetrics } from "./realtime-voice-metrics.ts";
import type { ConversationTransportHealth, HealthPillLevel } from "../types/health-push.ts";

export const CONVERSATION_PENDING_WARNING_MS = 2 * 60 * 1000;
export const CONVERSATION_PENDING_INCIDENT_MS = 5 * 60 * 1000;
export const VOICE_ACK_TARGET_MS = 1000;
export const VOICE_INTERRUPTION_TARGET_MS = 250;

type CallLatencyRow = { realtime_voice_latency?: unknown };

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

/** Content-free aggregate over the already-sanitized per-call timing payload. */
export function summarizeConversationVoiceHealth(calls: CallLatencyRow[]) {
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
  return {
    voice_calls_observed: callMetrics.filter((metrics) => metrics.length > 0).length,
    voice_turns_observed: turns.length,
    average_acknowledgement_ms: average(acknowledgements),
    slowest_interruption_clear_ms: interruptions.length > 0 ? Math.max(...interruptions) : null,
  };
}

export function conversationTransportHasIncident(health: Omit<ConversationTransportHealth, "level" | "operational_incident">) {
  return health.query_errors > 0
    || health.unavailable_capabilities.length > 0
    || health.processing_jobs_stuck > 0
    || health.failed_jobs_24h > 0
    || health.running_tasks_stuck > 0
    || health.failed_tasks_24h > 0
    || health.active_calls_stale > 0
    || (health.oldest_pending_job_ms ?? 0) > CONVERSATION_PENDING_INCIDENT_MS;
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
