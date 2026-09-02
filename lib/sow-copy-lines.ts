import type { SowLineKind } from "@/types";

export interface SowLineCopySource {
  text: string;
  kind: SowLineKind;
  trade: string | null;
}

export interface SowLineCopyInsert extends SowLineCopySource {
  section_id: string;
  sort: number;
}

/**
 * Builds the rows for one atomic multi-room copy insert. Source order
 * is preserved in every room and copied rows begin after that room's
 * current highest sort value.
 */
export function buildSowLineCopies(
  sourceLines: SowLineCopySource[],
  targetSectionIds: string[],
  maxSortBySection: ReadonlyMap<string, number>
): SowLineCopyInsert[] {
  return targetSectionIds.flatMap((sectionId) => {
    const startSort = maxSortBySection.get(sectionId) ?? 0;
    return sourceLines.map((line, index) => ({
      section_id: sectionId,
      text: line.text,
      kind: line.kind,
      trade: line.trade,
      sort: startSort + index + 1,
    }));
  });
}
