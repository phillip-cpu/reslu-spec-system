export type SowPlanScope = "interior" | "exterior" | "shared";

const EXTERIOR_ROOM_PATTERN = /\b(?:alfresco|backyard|courtyard|external|exterior|facade|façade|garden|landscape|outdoor|patio|pool|roof|terrace|verandah)\b/i;
const EXTERIOR_PLAN_PATTERN = /\b(?:external|exterior|facade|façade|landscape|outdoor|site\s+works?)\b/i;
const INTERIOR_PLAN_PATTERN = /\b(?:internal|interior|joinery)\b/i;

export function sowRoomPlanScope(roomName: string): Exclude<SowPlanScope, "shared"> {
  return EXTERIOR_ROOM_PATTERN.test(roomName) ? "exterior" : "interior";
}

export function sowPlanFileScope(filename: string): SowPlanScope {
  const searchableFilename = filename.replace(/[_-]+/g, " ");
  if (EXTERIOR_PLAN_PATTERN.test(searchableFilename)) return "exterior";
  if (INTERIOR_PLAN_PATTERN.test(searchableFilename)) return "interior";
  return "shared";
}

/**
 * Returns only drawing sets that can reasonably evidence the named room.
 * Clearly-labelled Interior/Joinery sets must never be presented as the
 * reference for an exterior room (or vice versa). Unlabelled general sets
 * remain shared because they may legitimately cover the whole project.
 */
export function planFilenamesForSowRoom(roomName: string, filenames: string[]): string[] {
  const roomScope = sowRoomPlanScope(roomName);
  return [...new Set(filenames.map((name) => name.trim()).filter(Boolean))].filter((filename) => {
    const fileScope = sowPlanFileScope(filename);
    return fileScope === "shared" || fileScope === roomScope;
  });
}

/**
 * Detects the common staged-document case: one discipline is clearly present
 * while the separate set needed for this room has not yet been uploaded.
 */
export function sowRoomAwaitsWorkingDrawings(roomName: string, filenames: string[]): boolean {
  const roomScope = sowRoomPlanScope(roomName);
  const scopes = new Set(filenames.map(sowPlanFileScope));
  return !scopes.has("shared") && !scopes.has(roomScope) && scopes.size > 0;
}
