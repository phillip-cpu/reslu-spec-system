export const CONVERSATION_VOICE_NOTE_MIME_TYPES = ["audio/mp4", "audio/webm"] as const;
export type ConversationVoiceNoteMime = typeof CONVERSATION_VOICE_NOTE_MIME_TYPES[number];

export const MAX_CONVERSATION_VOICE_NOTE_DURATION_MS = 5 * 60 * 1000;
export const MIN_CONVERSATION_VOICE_NOTE_DURATION_MS = 250;
export const MAX_CONVERSATION_VOICE_NOTE_BYTES = 10 * 1024 * 1024;

export function isConversationVoiceNoteMime(value: unknown): value is ConversationVoiceNoteMime {
  return typeof value === "string"
    && CONVERSATION_VOICE_NOTE_MIME_TYPES.includes(value as ConversationVoiceNoteMime);
}

export function isConversationVoiceNoteDuration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= MIN_CONVERSATION_VOICE_NOTE_DURATION_MS
    && value <= MAX_CONVERSATION_VOICE_NOTE_DURATION_MS;
}

export function voiceNoteDurationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function voiceNoteExtension(mimeType: ConversationVoiceNoteMime): "m4a" | "webm" {
  return mimeType === "audio/mp4" ? "m4a" : "webm";
}

export function voiceNoteMetadata(durationMs: number): Record<string, unknown> {
  return {
    voice_note: true,
    duration_ms: durationMs,
  };
}

export function isVoiceNoteMetadata(value: unknown): value is {
  voice_note: true;
  duration_ms: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.voice_note === true
    && isConversationVoiceNoteDuration(metadata.duration_ms);
}
