export type BrainNoteClassification = {
  source?: string | null;
};

/** Agent source ids are stored canonically so graph routing stays deterministic. */
export function normalizeBrainNoteSource(source: string | undefined): string {
  return source?.trim().toLowerCase().slice(0, 80) || "aria";
}

/** Marco-owned publications form their own visual cluster while remaining memory search records. */
export function isMarcoBrainNote(note: BrainNoteClassification): boolean {
  return note.source?.trim().toLowerCase() === "marco";
}

/** Stuart-owned publications are finance knowledge and remain admin-visible. */
export function isStuartBrainNote(note: BrainNoteClassification): boolean {
  return note.source?.trim().toLowerCase() === "stuart";
}
