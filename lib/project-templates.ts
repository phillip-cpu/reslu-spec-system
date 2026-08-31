import type { PhaseTemplateRow } from "@/lib/phase-template";

export const PROJECT_TYPES = [
  "new_build",
  "whole_home_renovation",
  "extension",
  "single_room_renovation",
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export const SINGLE_ROOM_PROJECT_SUBTYPES = [
  "kitchen",
  "bathroom",
  "ensuite",
  "laundry",
  "other",
] as const;

export type SingleRoomProjectSubtype = (typeof SINGLE_ROOM_PROJECT_SUBTYPES)[number];
export type ProjectSubtype = SingleRoomProjectSubtype | null;

export const DEFAULT_PROJECT_TYPE: ProjectType = "whole_home_renovation";

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  new_build: "New build",
  whole_home_renovation: "Whole-home renovation",
  extension: "Extension / addition",
  single_room_renovation: "Single-room renovation",
};

export const PROJECT_SUBTYPE_LABELS: Record<SingleRoomProjectSubtype, string> = {
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  ensuite: "Ensuite",
  laundry: "Laundry",
  other: "Other",
};

export type ProjectPhaseTemplates = Record<ProjectType, PhaseTemplateRow[]>;
export interface ClientPaymentStageTemplate {
  label: string;
  percentage: number;
  /** Exact default Timeline phase whose end date triggers this client claim. */
  phaseName: string | null;
}
export type ProjectPaymentStageTemplates = Record<ProjectType, ClientPaymentStageTemplate[]>;

const phase = (name: string): PhaseTemplateRow => ({ name, kind: "phase" });

/**
 * Editable starting points only. They are selected from projects.project_type
 * when an empty Timeline is first seeded; changing a project type never
 * rewrites an established Timeline.
 */
export const FALLBACK_PROJECT_PHASE_TEMPLATES: ProjectPhaseTemplates = {
  new_build: [
    phase("Site Establishment"),
    phase("Earthworks, Footings & Base"),
    phase("Structural & Framing"),
    phase("External Envelope"),
    phase("Services Rough In"),
    phase("Internal Linings & Waterproofing"),
    phase("Internal Finishes"),
    phase("Joinery & Fixed Elements"),
    phase("Fit Off"),
    phase("Painting & Final Detail"),
    phase("External Works"),
    phase("Practical Completion"),
    phase("Handover & Close Out"),
  ],
  whole_home_renovation: [
    phase("Site Establishment & Protection"),
    phase("Demolition & Strip Out"),
    phase("Structural Alterations & Framing"),
    phase("External Envelope"),
    phase("Services Rough In"),
    phase("Internal Linings & Waterproofing"),
    phase("Internal Finishes"),
    phase("Joinery & Fixed Elements"),
    phase("Fit Off"),
    phase("Painting & Final Detail"),
    phase("External Works"),
    phase("Practical Completion"),
    phase("Handover & Close Out"),
  ],
  extension: [
    phase("Site Establishment & Protection"),
    phase("Demolition & Opening Works"),
    phase("Earthworks, Footings & Base"),
    phase("Structural & Framing"),
    phase("External Envelope"),
    phase("Existing Home Integration"),
    phase("Services Rough In"),
    phase("Internal Linings & Waterproofing"),
    phase("Internal Finishes"),
    phase("Joinery & Fixed Elements"),
    phase("Fit Off"),
    phase("Painting & Final Detail"),
    phase("External Works"),
    phase("Practical Completion"),
    phase("Handover & Close Out"),
  ],
  single_room_renovation: [
    phase("Site Establishment & Protection"),
    phase("Demolition & Strip Out"),
    phase("Services Rough In"),
    phase("Internal Linings & Waterproofing"),
    phase("Internal Finishes"),
    phase("Joinery & Fixed Elements"),
    phase("Fit Off"),
    phase("Painting & Final Detail"),
    phase("Practical Completion"),
    phase("Handover & Close Out"),
  ],
};

/**
 * Editable claim starting points for the original construction contract. They
 * total 100% and keep Deposit at 5%. Joinery is always visible as its own
 * milestone so it cannot disappear inside generic fit-out; the team must still
 * replace the illustrative split with the signed, cost-loaded contract.
 */
export const FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES: ProjectPaymentStageTemplates = {
  new_build: [
    { label: "Deposit", percentage: 5, phaseName: null },
    { label: "Site works, footings & base", percentage: 15, phaseName: "Earthworks, Footings & Base" },
    { label: "Structural & framing", percentage: 15, phaseName: "Structural & Framing" },
    { label: "External envelope", percentage: 15, phaseName: "External Envelope" },
    { label: "Services rough in", percentage: 10, phaseName: "Services Rough In" },
    { label: "Internal linings & waterproofing", percentage: 10, phaseName: "Internal Linings & Waterproofing" },
    { label: "Internal finishes", percentage: 10, phaseName: "Internal Finishes" },
    { label: "Joinery package", percentage: 10, phaseName: "Joinery & Fixed Elements" },
    { label: "Fit off & final detail", percentage: 5, phaseName: "Painting & Final Detail" },
    { label: "Practical completion", percentage: 5, phaseName: "Practical Completion" },
  ],
  whole_home_renovation: [
    { label: "Deposit", percentage: 5, phaseName: null },
    { label: "Site establishment & demolition complete", percentage: 15, phaseName: "Demolition & Strip Out" },
    { label: "Structural alterations & services rough in complete", percentage: 20, phaseName: "Services Rough In" },
    { label: "Internal linings & waterproofing complete", percentage: 15, phaseName: "Internal Linings & Waterproofing" },
    { label: "Internal finishes & joinery substantially complete", percentage: 20, phaseName: "Joinery & Fixed Elements" },
    { label: "Fit off & final detailing complete", percentage: 20, phaseName: "Painting & Final Detail" },
    { label: "Practical completion", percentage: 5, phaseName: "Practical Completion" },
  ],
  extension: [
    { label: "Deposit", percentage: 5, phaseName: null },
    { label: "Demolition, footings & base", percentage: 15, phaseName: "Earthworks, Footings & Base" },
    { label: "Structural & framing", percentage: 15, phaseName: "Structural & Framing" },
    { label: "External envelope", percentage: 15, phaseName: "External Envelope" },
    { label: "Existing home integration & services rough in", percentage: 10, phaseName: "Services Rough In" },
    { label: "Internal linings & waterproofing", percentage: 10, phaseName: "Internal Linings & Waterproofing" },
    { label: "Internal finishes", percentage: 10, phaseName: "Internal Finishes" },
    { label: "Joinery package", percentage: 10, phaseName: "Joinery & Fixed Elements" },
    { label: "Fit off & final detail", percentage: 5, phaseName: "Painting & Final Detail" },
    { label: "Practical completion", percentage: 5, phaseName: "Practical Completion" },
  ],
  single_room_renovation: [
    { label: "Deposit", percentage: 5, phaseName: null },
    { label: "Site establishment, demolition & services rough in complete", percentage: 25, phaseName: "Services Rough In" },
    { label: "Internal linings, waterproofing & finishes complete", percentage: 25, phaseName: "Internal Finishes" },
    { label: "Joinery, fixtures & fit off complete", percentage: 35, phaseName: "Fit Off" },
    { label: "Practical completion", percentage: 10, phaseName: "Practical Completion" },
  ],
};

export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === "string" && (PROJECT_TYPES as readonly string[]).includes(value);
}

export function isSingleRoomProjectSubtype(value: unknown): value is SingleRoomProjectSubtype {
  return typeof value === "string" &&
    (SINGLE_ROOM_PROJECT_SUBTYPES as readonly string[]).includes(value);
}

export function normaliseProjectSubtype(
  projectType: ProjectType,
  subtype: unknown
): ProjectSubtype {
  if (projectType !== "single_room_renovation") return null;
  return isSingleRoomProjectSubtype(subtype) ? subtype : null;
}

export function inferProjectTypeFromText(value: unknown): ProjectType {
  if (isProjectType(value)) return value;
  const text = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  if (/new\s*build/.test(text)) return "new_build";
  if (/extension|addition/.test(text)) return "extension";
  if (/kitchen|bathroom|ensuite|laundry|single[\s-]*room/.test(text)) {
    return "single_room_renovation";
  }
  return DEFAULT_PROJECT_TYPE;
}

export function inferSingleRoomSubtypeFromText(value: unknown): ProjectSubtype {
  const text = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  if (/ensuite/.test(text)) return "ensuite";
  if (/bathroom/.test(text)) return "bathroom";
  if (/kitchen/.test(text)) return "kitchen";
  if (/laundry/.test(text)) return "laundry";
  return text ? "other" : null;
}

/**
 * Accepts the new per-project-type map and the legacy single array. A legacy
 * array is retained as the whole-home template while the other types keep
 * their code fallbacks, so rollout does not discard an admin's existing edits.
 */
export function resolveProjectPhaseTemplates(value: unknown): ProjectPhaseTemplates {
  if (Array.isArray(value)) {
    return {
      ...FALLBACK_PROJECT_PHASE_TEMPLATES,
      whole_home_renovation: value as PhaseTemplateRow[],
    };
  }

  if (!value || typeof value !== "object") return FALLBACK_PROJECT_PHASE_TEMPLATES;
  const source = value as Partial<Record<ProjectType, unknown>>;
  const resolved = { ...FALLBACK_PROJECT_PHASE_TEMPLATES };
  for (const projectType of PROJECT_TYPES) {
    if (Array.isArray(source[projectType]) && source[projectType]!.length > 0) {
      resolved[projectType] = source[projectType] as PhaseTemplateRow[];
    }
  }
  return resolved;
}

export function templateForProjectType(
  templates: ProjectPhaseTemplates,
  projectType: unknown
): PhaseTemplateRow[] {
  return templates[isProjectType(projectType) ? projectType : DEFAULT_PROJECT_TYPE];
}
