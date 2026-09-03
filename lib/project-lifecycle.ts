import type { ProjectStatus, ProjectStage } from "@/types";

export const PROJECT_STAGE_OPTIONS: ReadonlyArray<{
  value: ProjectStage;
  label: string;
}> = [
  { value: "quoting", label: "Proposal / quoting" },
  { value: "design", label: "Design" },
  { value: "preconstruction", label: "Pre-construction" },
  { value: "construction", label: "Construction" },
  { value: "handover", label: "Handover" },
  { value: "complete", label: "Finalised" },
  { value: "on_hold", label: "On hold" },
];

export const JOB_LIFECYCLE_STEPS = [
  { key: "lead", label: "Lead" },
  { key: "proposal", label: "Proposal" },
  { key: "design", label: "Design" },
  { key: "preconstruction", label: "Pre-construction" },
  { key: "construction", label: "Construction" },
  { key: "handover", label: "Handover" },
  { key: "finalised", label: "Finalised" },
] as const;

export function projectStageLabel(stage: ProjectStage): string {
  return PROJECT_STAGE_OPTIONS.find((option) => option.value === stage)?.label ?? stage;
}

/** Maps delivery stages onto the visible lead-to-finalised lifecycle. */
export function lifecycleStepIndex(stage: ProjectStage): number | null {
  switch (stage) {
    case "quoting":
      return 1;
    case "design":
      return 2;
    case "preconstruction":
      return 3;
    case "construction":
      return 4;
    case "handover":
      return 5;
    case "complete":
      return 6;
    case "on_hold":
      return null;
  }
}

export function nextProjectStage(stage: ProjectStage): ProjectStage | null {
  switch (stage) {
    case "quoting":
      return "design";
    case "design":
      return "preconstruction";
    case "preconstruction":
      return "construction";
    case "construction":
      return "handover";
    case "handover":
      return "complete";
    case "complete":
    case "on_hold":
      return null;
  }
}

/** Finalised is the lifecycle source of truth; archived remains a separate record state. */
export function projectStatusForStage(
  stage: ProjectStage,
  currentStatus: ProjectStatus
): ProjectStatus {
  if (currentStatus === "archived") return "archived";
  return stage === "complete" ? "completed" : "active";
}

/** A project created from a lead starts at the lead's strongest known delivery stage. */
export function projectStageForLeadStage(leadStage: string): ProjectStage {
  if (leadStage === "Complete") return "complete";
  if (leadStage === "Construction In Progress") return "construction";
  if (leadStage === "Design Work In Progress") return "design";
  return "quoting";
}
