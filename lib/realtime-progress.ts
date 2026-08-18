export const REALTIME_PROGRESS_KIND = "reslu_progress";

const REALTIME_PROGRESS_ACKNOWLEDGEMENTS: Record<string, readonly string[]> = {
  aria: ["I’ll take care of that.", "I’ll pull that together.", "Leave that with me."],
  marco: ["On it.", "I’ll get into that.", "I’ll work through it."],
  stuart: ["Right.", "I’ll deal with that.", "Understood."],
};

const FALLBACK_ACKNOWLEDGEMENTS = [
  "I’ll take care of that.",
  "I’ll work through it.",
  "Leave that with me.",
] as const;

export function realtimeProgressAcknowledgement(agentSlug: string, turn: number): string {
  const options = REALTIME_PROGRESS_ACKNOWLEDGEMENTS[agentSlug] ?? FALLBACK_ACKNOWLEDGEMENTS;
  const index = Math.max(0, Math.floor(turn) - 1) % options.length;
  return options[index];
}

export function realtimeProgressCueId(response: {
  metadata?: Record<string, unknown>;
} | null | undefined): string | null {
  if (response?.metadata?.reslu_kind !== REALTIME_PROGRESS_KIND) return null;
  const cueId = response.metadata.reslu_cue_id;
  return typeof cueId === "string" && cueId.length > 0 ? cueId : null;
}
