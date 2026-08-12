export interface NativeVoiceContinuityMetadata {
  schema_version: 1;
  transport: "native_webrtc_callkit";
  background_transitions: number;
  reconnect_attempts: number;
  data_channel_opens: number;
  audio_route_changes: number;
  callkit_audio_activations: number;
  mute_changes: number;
  ended_while_background: boolean;
  replayed_web_events: number;
  peak_buffered_web_events: number;
}

const COUNT_KEYS = [
  "background_transitions",
  "reconnect_attempts",
  "data_channel_opens",
  "audio_route_changes",
  "callkit_audio_activations",
  "mute_changes",
  "replayed_web_events",
] as const satisfies ReadonlyArray<keyof NativeVoiceContinuityMetadata>;

function boundedInteger(value: unknown, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : 0;
}

export function sanitizeNativeVoiceContinuity(value: unknown): NativeVoiceContinuityMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1 || candidate.transport !== "native_webrtc_callkit") return null;
  const result: NativeVoiceContinuityMetadata = {
    schema_version: 1,
    transport: "native_webrtc_callkit",
    background_transitions: 0,
    reconnect_attempts: 0,
    data_channel_opens: 0,
    audio_route_changes: 0,
    callkit_audio_activations: 0,
    mute_changes: 0,
    ended_while_background: candidate.ended_while_background === true,
    replayed_web_events: 0,
    peak_buffered_web_events: boundedInteger(candidate.peak_buffered_web_events, 80),
  };
  for (const key of COUNT_KEYS) result[key] = boundedInteger(candidate[key], 1_000);
  return result;
}
