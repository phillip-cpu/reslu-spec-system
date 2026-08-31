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
  interruption_to_mute_ms?: number;
  interruption_to_buffer_cleared_ms?: number;
}

export interface RealtimeVoiceLatencyMetadata {
  schema_version: 1 | 2;
  transport: "openai_realtime_webrtc";
  summary: {
    observed_turns: number;
    spoken_turns: number;
    average_acknowledgement_ms: number | null;
    average_queue_wait_ms: number | null;
    average_agent_processing_ms: number | null;
    average_total_turn_ms: number | null;
    slowest_total_turn_ms: number | null;
    observed_interruptions: number;
    average_interruption_clear_ms: number | null;
    slowest_interruption_clear_ms: number | null;
  };
  turns: RealtimeVoiceLatencyMetric[];
  usage?: RealtimeVoiceUsageMetadata;
}

export interface RealtimeTokenUsageTotals {
  count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  input_image_tokens: number;
  cached_tokens: number;
  output_text_tokens: number;
  output_audio_tokens: number;
}

export interface RealtimeTranscriptionUsageTotals {
  count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  seconds: number;
}

export interface RealtimeVoiceUsageMetadata {
  schema_version: 1;
  source: "openai_realtime_response_done_client_observed";
  realtime_model: string | null;
  transcription_model: string | null;
  responses: RealtimeTokenUsageTotals;
  transcriptions: RealtimeTranscriptionUsageTotals;
}

export interface RealtimeVoiceUsageAccumulator {
  realtimeModel: string | null;
  transcriptionModel: string | null;
  responses: RealtimeTokenUsageTotals;
  transcriptions: RealtimeTranscriptionUsageTotals;
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
  "interruption_to_mute_ms",
  "interruption_to_buffer_cleared_ms",
] as const satisfies ReadonlyArray<keyof RealtimeVoiceLatencyMetric>;

const MAX_USAGE_COUNT = 10_000;
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_TRANSCRIPTION_SECONDS = 24 * 60 * 60;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function emptyResponseUsage(): RealtimeTokenUsageTotals {
  return {
    count: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    input_text_tokens: 0,
    input_audio_tokens: 0,
    input_image_tokens: 0,
    cached_tokens: 0,
    output_text_tokens: 0,
    output_audio_tokens: 0,
  };
}

function emptyTranscriptionUsage(): RealtimeTranscriptionUsageTotals {
  return {
    count: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    input_text_tokens: 0,
    input_audio_tokens: 0,
    seconds: 0,
  };
}

export function createRealtimeVoiceUsageAccumulator(): RealtimeVoiceUsageAccumulator {
  return {
    realtimeModel: null,
    transcriptionModel: null,
    responses: emptyResponseUsage(),
    transcriptions: emptyTranscriptionUsage(),
  };
}

function boundedInteger(value: unknown, maximum = MAX_TOKEN_COUNT): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : 0;
}

function boundedSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TRANSCRIPTION_SECONDS
    ? Math.round(value * 1000) / 1000
    : 0;
}

function usageObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function setRealtimeVoiceUsageModels(
  accumulator: RealtimeVoiceUsageAccumulator,
  realtimeModel: unknown,
  transcriptionModel: unknown,
) {
  if (typeof realtimeModel === "string" && MODEL_PATTERN.test(realtimeModel)) {
    accumulator.realtimeModel = realtimeModel;
  }
  if (typeof transcriptionModel === "string" && MODEL_PATTERN.test(transcriptionModel)) {
    accumulator.transcriptionModel = transcriptionModel;
  }
}

export function addRealtimeResponseUsage(accumulator: RealtimeVoiceUsageAccumulator, value: unknown) {
  const usage = usageObject(value);
  if (Object.keys(usage).length === 0 || accumulator.responses.count >= MAX_USAGE_COUNT) return;
  const inputDetails = usageObject(usage.input_token_details);
  const outputDetails = usageObject(usage.output_token_details);
  const next = accumulator.responses;
  next.count += 1;
  next.total_tokens += boundedInteger(usage.total_tokens);
  next.input_tokens += boundedInteger(usage.input_tokens);
  next.output_tokens += boundedInteger(usage.output_tokens);
  next.input_text_tokens += boundedInteger(inputDetails.text_tokens);
  next.input_audio_tokens += boundedInteger(inputDetails.audio_tokens);
  next.input_image_tokens += boundedInteger(inputDetails.image_tokens);
  next.cached_tokens += boundedInteger(inputDetails.cached_tokens);
  next.output_text_tokens += boundedInteger(outputDetails.text_tokens);
  next.output_audio_tokens += boundedInteger(outputDetails.audio_tokens);
}

export function addRealtimeTranscriptionUsage(accumulator: RealtimeVoiceUsageAccumulator, value: unknown) {
  const usage = usageObject(value);
  if (Object.keys(usage).length === 0 || accumulator.transcriptions.count >= MAX_USAGE_COUNT) return;
  const inputDetails = usageObject(usage.input_token_details);
  const next = accumulator.transcriptions;
  next.count += 1;
  next.total_tokens += boundedInteger(usage.total_tokens);
  next.input_tokens += boundedInteger(usage.input_tokens);
  next.output_tokens += boundedInteger(usage.output_tokens);
  next.input_text_tokens += boundedInteger(inputDetails.text_tokens);
  next.input_audio_tokens += boundedInteger(inputDetails.audio_tokens);
  next.seconds += boundedSeconds(usage.seconds);
  next.seconds = Math.round(next.seconds * 1000) / 1000;
}

export function realtimeVoiceUsageSnapshot(accumulator: RealtimeVoiceUsageAccumulator): RealtimeVoiceUsageMetadata | null {
  if (accumulator.responses.count === 0 && accumulator.transcriptions.count === 0) return null;
  return {
    schema_version: 1,
    source: "openai_realtime_response_done_client_observed",
    realtime_model: accumulator.realtimeModel,
    transcription_model: accumulator.transcriptionModel,
    responses: { ...accumulator.responses },
    transcriptions: { ...accumulator.transcriptions },
  };
}

function sanitizeModel(value: unknown): string | null {
  return typeof value === "string" && MODEL_PATTERN.test(value) ? value : null;
}

function sanitizeResponseUsage(value: unknown): RealtimeTokenUsageTotals {
  const source = usageObject(value);
  const output = emptyResponseUsage();
  for (const key of Object.keys(output) as Array<keyof RealtimeTokenUsageTotals>) {
    output[key] = boundedInteger(source[key], key === "count" ? MAX_USAGE_COUNT : MAX_TOKEN_COUNT);
  }
  return output;
}

function sanitizeTranscriptionUsage(value: unknown): RealtimeTranscriptionUsageTotals {
  const source = usageObject(value);
  const output = emptyTranscriptionUsage();
  for (const key of Object.keys(output) as Array<keyof RealtimeTranscriptionUsageTotals>) {
    output[key] = key === "seconds"
      ? boundedSeconds(source[key])
      : boundedInteger(source[key], key === "count" ? MAX_USAGE_COUNT : MAX_TOKEN_COUNT);
  }
  return output;
}

export function sanitizeRealtimeVoiceUsage(value: unknown): RealtimeVoiceUsageMetadata | null {
  const source = usageObject(value);
  if (Object.keys(source).length === 0) return null;
  const responses = sanitizeResponseUsage(source.responses);
  const transcriptions = sanitizeTranscriptionUsage(source.transcriptions);
  if (responses.count === 0 && transcriptions.count === 0) return null;
  return {
    schema_version: 1,
    source: "openai_realtime_response_done_client_observed",
    realtime_model: sanitizeModel(source.realtime_model),
    transcription_model: sanitizeModel(source.transcription_model),
    responses,
    transcriptions,
  };
}

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
  const envelope = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const turns = sanitizeRealtimeVoiceMetrics(envelope?.turns ?? value);
  const usage = sanitizeRealtimeVoiceUsage(envelope?.usage);
  if (turns.length === 0 && !usage) return null;
  const totalTurns = turns.flatMap((metric) => typeof metric.speech_to_first_audio_ms === "number"
    ? [metric.speech_to_first_audio_ms]
    : []);
  const interruptions = turns.flatMap((metric) => typeof metric.interruption_to_buffer_cleared_ms === "number"
    ? [metric.interruption_to_buffer_cleared_ms]
    : []);
  return {
    schema_version: usage ? 2 : 1,
    transport: "openai_realtime_webrtc",
    summary: {
      observed_turns: turns.length,
      spoken_turns: turns.filter((metric) => metric.outcome === "spoken").length,
      average_acknowledgement_ms: average(turns, "speech_to_ack_ms"),
      average_queue_wait_ms: average(turns, "queue_wait_ms"),
      average_agent_processing_ms: average(turns, "agent_processing_ms"),
      average_total_turn_ms: average(turns, "speech_to_first_audio_ms"),
      slowest_total_turn_ms: totalTurns.length > 0 ? Math.max(...totalTurns) : null,
      observed_interruptions: interruptions.length,
      average_interruption_clear_ms: average(turns, "interruption_to_buffer_cleared_ms"),
      slowest_interruption_clear_ms: interruptions.length > 0 ? Math.max(...interruptions) : null,
    },
    turns,
    ...(usage ? { usage } : {}),
  };
}
