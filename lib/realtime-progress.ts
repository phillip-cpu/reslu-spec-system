export const REALTIME_PROGRESS_KIND = "reslu_progress";

export function buildRealtimeProgressResponse(cueId: string) {
  return {
    type: "response.create",
    response: {
      // Out-of-band responses may run in parallel with the default response
      // that selects the authoritative RESLU tool. They do not pollute the
      // conversation or delay that tool call.
      conversation: "none",
      metadata: {
        reslu_kind: REALTIME_PROGRESS_KIND,
        reslu_cue_id: cueId,
      },
      input: [],
      output_modalities: ["audio"],
      tool_choice: "none",
      instructions: 'Say exactly: "I’m checking that now."',
    },
  } as const;
}

export function realtimeProgressCueId(response: {
  metadata?: Record<string, unknown>;
} | null | undefined): string | null {
  if (response?.metadata?.reslu_kind !== REALTIME_PROGRESS_KIND) return null;
  const cueId = response.metadata.reslu_cue_id;
  return typeof cueId === "string" && cueId.length > 0 ? cueId : null;
}
