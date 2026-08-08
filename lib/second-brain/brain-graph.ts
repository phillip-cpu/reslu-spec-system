export type BrainLinkCandidate = {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
};

export type BrainLink = {
  source: string;
  target: string;
  relation: string;
};

export function brainNodeKey(entityType: string, id: string): string {
  return `${entityType}:${id}`;
}

/** Keep only links whose two endpoints are visible and collapse duplicate evidence. */
export function buildVisibleBrainLinks(
  candidates: BrainLinkCandidate[],
  visibleNodeKeys: Set<string>
): BrainLink[] {
  const links = new Map<string, BrainLink>();

  for (const candidate of candidates) {
    const source = brainNodeKey(candidate.sourceType, candidate.sourceId);
    const target = brainNodeKey(candidate.targetType, candidate.targetId);
    if (source === target || !visibleNodeKeys.has(source) || !visibleNodeKeys.has(target)) continue;

    const pair = [source, target].sort().join("|");
    const dedupeKey = `${pair}|${candidate.relation}`;
    if (!links.has(dedupeKey)) {
      links.set(dedupeKey, { source, target, relation: candidate.relation });
    }
  }

  return [...links.values()];
}
