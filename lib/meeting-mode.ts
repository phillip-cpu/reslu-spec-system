import type { MeetingDestinationCandidate, MeetingTranscriptSegment, MeetingType } from "@/types/meeting-mode";

export const MAX_MEETING_TRANSCRIPT_CHARS = 500_000;
export const MAX_MEETING_SEGMENTS = 2_000;
export const MAX_MEETING_LIST_ITEMS = 100;
export const MAX_MEETING_AUDIO_BYTES = 250 * 1024 * 1024;
const MEETING_RECORDING_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/webm",
  "audio/webm;codecs=opus",
]);

export function validMeetingRecordingMimeType(value: unknown): value is string {
  return typeof value === "string" && MEETING_RECORDING_MIME_TYPES.has(value);
}

export function cleanMeetingString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim().slice(0, maxLength);
  return result || null;
}

export function cleanMeetingStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => typeof item === "string" ? [item.trim().slice(0, 2_000)] : [])
    .filter(Boolean)
    .slice(0, MAX_MEETING_LIST_ITEMS);
}

export function cleanMeetingTranscriptSegments(value: unknown): MeetingTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: MeetingTranscriptSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const itemId = cleanMeetingString(row.item_id, 160);
    const text = cleanMeetingString(row.text, 20_000);
    const sequence = Number(row.sequence);
    const capturedAt = typeof row.captured_at === "string" && !Number.isNaN(Date.parse(row.captured_at))
      ? new Date(row.captured_at).toISOString()
      : new Date().toISOString();
    if (!itemId || !text || seen.has(itemId) || !Number.isInteger(sequence) || sequence < 0) continue;
    seen.add(itemId);
    result.push({ item_id: itemId, text, sequence, captured_at: capturedAt });
  }
  return result.sort((left, right) => left.sequence - right.sequence).slice(0, MAX_MEETING_SEGMENTS);
}

export function transcriptFromMeetingSegments(segments: MeetingTranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join("\n").slice(0, MAX_MEETING_TRANSCRIPT_CHARS);
}

export function rankMeetingCandidates(candidates: MeetingDestinationCandidate[]): {
  candidates: MeetingDestinationCandidate[];
  suggested: MeetingDestinationCandidate | null;
  needsClarification: boolean;
} {
  const sorted = [...candidates].sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
  const first = sorted[0] ?? null;
  const second = sorted[1] ?? null;
  const unambiguous = Boolean(first && first.confidence >= 0.85 && (!second || first.confidence - second.confidence >= 0.15));
  return {
    candidates: sorted,
    suggested: unambiguous ? first : null,
    needsClarification: !unambiguous,
  };
}

export function meetingTypeForTitle(title: string, fallback: MeetingType = "client_meeting"): MeetingType {
  const normalized = title.toLowerCase();
  if (/new lead|consult|site visit/.test(normalized)) return "new_lead";
  if (/design|selection|selections/.test(normalized)) return "design_meeting";
  if (/site|construction/.test(normalized)) return "site_meeting";
  return fallback;
}

export function meetingRecordingStoragePath(
  conversationId: string,
  userId: string,
  meetingId: string,
  filename: string,
): string {
  const extension = filename.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "m4a";
  return `meeting-minutes/${conversationId}/${userId}/${meetingId}/recording.${extension}`;
}

export function validMeetingRecordingStoragePath(
  path: string,
  conversationId: string,
  userId: string,
  meetingId: string,
): boolean {
  const prefix = `meeting-minutes/${conversationId}/${userId}/${meetingId}/recording.`;
  return path.startsWith(prefix) && /^[a-z0-9]{1,8}$/.test(path.slice(prefix.length));
}
