export const MAX_REALTIME_VOICE_METRICS = 20;
const MAX_DURATION_MS = 30 * 60 * 1000;

export const REALTIME_VOICE_OUTCOMES = ["spoken", "cancelled", "failed", "pending"] as const;
export type RealtimeVoiceOutcome = (typeof REALTIME_VOICE_OUTCOMES)[number];

export interface RealtimeVoiceLatencyMetric {
  turn: number;
  outcome: RealtimeVoiceOutcome;
  speech_to_ack_ms?: number;
  ack_request_to_audio_ms?: number;
  speech_to_tool_ms?: number;
  consult_accept_ms?: number;
  consult_round_trip_ms?: number;
  queue_wait_ms?: number;
  agent_processing_ms?: number;
  backend_total_ms?: number;
  response_to_first_audio_ms?: number;
  speech_to_first_audio_ms?: number;
}

export interface RealtimeVoiceLatencyMetadata {
  schema_version: 1;
  transport: "openai_realtime_webrtc";
  summary: {
    observed_turns: number;
    spoken_turns: number;
    average_acknowledgement_ms: number | null;
    average_queue_wait_ms: number | null;
    average_agent_processing_ms: number | null;
    average_total_turn_ms: number | null;
    slowest_total_turn_ms: number | null;
  };
  turns: RealtimeVoiceLatencyMetric[];
}

const DURATION_KEYS = [
  "speech_to_ack_ms",
  "ack_request_to_audio_ms",
  "speech_to_tool_ms",
  "consult_accept_ms",
  "consult_round_trip_ms",
  "queue_wait_ms",
  "agent_processing_ms",
  "backend_total_ms",
  "response_to_first_audio_ms",
  "speech_to_first_audio_ms",
] as const satisfies ReadonlyArray<keyof RealtimeVoiceLatencyMetric>;

function safeDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) return null;
  return Math.round(value);
}

function average(metrics: RealtimeVoiceLatencyMetric[], key: keyof RealtimeVoiceLatencyMetric): number | null {
  const values = metrics.flatMap((metric) => typeof metric[key] === "number" ? [metric[key] as number] : []);
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

export function millisecondsBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return safeDuration(endMs - startMs);
}

export function sanitizeRealtimeVoiceMetrics(value: unknown): RealtimeVoiceLatencyMetric[] {
  if (!Array.isArray(value)) return [];
  const metrics: RealtimeVoiceLatencyMetric[] = [];
  for (const entry of value.slice(0, MAX_REALTIME_VOICE_METRICS)) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const turn = typeof candidate.turn === "number" && Number.isInteger(candidate.turn)
      && candidate.turn >= 1 && candidate.turn <= 1000
      ? candidate.turn
      : null;
    const outcome = typeof candidate.outcome === "string"
      && REALTIME_VOICE_OUTCOMES.includes(candidate.outcome as RealtimeVoiceOutcome)
      ? candidate.outcome as RealtimeVoiceOutcome
      : null;
    if (turn == null || !outcome) continue;
    const metric: RealtimeVoiceLatencyMetric = { turn, outcome };
    for (const key of DURATION_KEYS) {
      const duration = safeDuration(candidate[key]);
      if (duration != null) metric[key] = duration;
    }
    metrics.push(metric);
  }
  return metrics;
}

export function buildRealtimeVoiceLatencyMetadata(value: unknown): RealtimeVoiceLatencyMetadata | null {
  const turns = sanitizeRealtimeVoiceMetrics(value);
  if (turns.length === 0) return null;
  const totalTurns = turns.flatMap((metric) => typeof metric.speech_to_first_audio_ms === "number"
    ? [metric.speech_to_first_audio_ms]
    : []);
  return {
    schema_version: 1,
    transport: "openai_realtime_webrtc",
    summary: {
      observed_turns: turns.length,
      spoken_turns: turns.filter((metric) => metric.outcome === "spoken").length,
      average_acknowledgement_ms: average(turns, "speech_to_ack_ms"),
      average_queue_wait_ms: average(turns, "queue_wait_ms"),
      average_agent_processing_ms: average(turns, "agent_processing_ms"),
      average_total_turn_ms: average(turns, "speech_to_first_audio_ms"),
      slowest_total_turn_ms: totalTurns.length > 0 ? Math.max(...totalTurns) : null,
    },
    turns,
  };
}
