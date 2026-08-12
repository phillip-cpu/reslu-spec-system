export const REALTIME_PROGRESS_KIND = "reslu_progress";

export function realtimeProgressCueId(response: {
  metadata?: Record<string, unknown>;
} | null | undefined): string | null {
  if (response?.metadata?.reslu_kind !== REALTIME_PROGRESS_KIND) return null;
  const cueId = response.metadata.reslu_cue_id;
  return typeof cueId === "string" && cueId.length > 0 ? cueId : null;
}
