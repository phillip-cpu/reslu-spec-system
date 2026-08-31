/**
 * Returns a copy of a SOW section's lines with one line moved to the
 * requested final index. Sort values are normalised to 1..n so the order
 * persists consistently for the builder, PDFs, and trade extracts.
 */
export function reorderSowLines<T extends { id: string; sort: number }>(
  lines: T[],
  lineId: string,
  destinationIndex: number
): T[] {
  const sourceIndex = lines.findIndex((line) => line.id === lineId);
  if (sourceIndex === -1 || lines.length < 2) return lines;

  const boundedIndex = Math.max(0, Math.min(destinationIndex, lines.length - 1));
  if (sourceIndex === boundedIndex) return lines;

  const reordered = [...lines];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(boundedIndex, 0, moved);

  return reordered.map((line, index) => ({ ...line, sort: index + 1 }));
}
