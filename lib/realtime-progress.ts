export const REALTIME_PROGRESS_KIND = "reslu_progress";
export const REALTIME_PROGRESS_DELAY_MS = 1_800;

type ProgressAgent = "aria" | "marco" | "stuart";

const PROGRESS_LINES: Record<ProgressAgent, readonly string[]> = {
  aria: ["Understood.", "I’ll handle it.", "Consider it in hand."],
  marco: ["Yep—leave it with me.", "Alright, let’s see what’s moving.", "I’m onto it."],
  stuart: ["Checking.", "Reviewing the figures.", "Verifying."],
};

export function buildRealtimeProgressResponse(cueId: string, agent: ProgressAgent, turn: number) {
  const lines = PROGRESS_LINES[agent];
  const line = lines[Math.abs(turn) % lines.length];
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
      instructions: `Say exactly: "${line}"`,
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
