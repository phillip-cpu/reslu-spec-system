export const ORGANIC_ACTION_STATUSES = [
  "new",
  "approved",
  "in_progress",
  "monitoring",
  "complete",
  "dismissed",
] as const;

export type OrganicActionStatus = (typeof ORGANIC_ACTION_STATUSES)[number];

const TRANSITIONS: Record<OrganicActionStatus, ReadonlySet<OrganicActionStatus>> = {
  new: new Set(["approved", "dismissed"]),
  approved: new Set(["in_progress", "dismissed"]),
  in_progress: new Set(["monitoring", "dismissed"]),
  monitoring: new Set(["complete", "in_progress", "dismissed"]),
  complete: new Set(["in_progress"]),
  dismissed: new Set(["new"]),
};

export function isOrganicActionStatus(value: unknown): value is OrganicActionStatus {
  return typeof value === "string" && ORGANIC_ACTION_STATUSES.includes(value as OrganicActionStatus);
}

export function canTransitionOrganicAction(
  current: OrganicActionStatus,
  next: OrganicActionStatus
): boolean {
  return TRANSITIONS[current].has(next);
}
