// ============================================================
// RESLU Spec System — Phase 12b LOCAL types
// Design Framework pipeline — see migration
// supabase/migrations/025_design_framework.sql,
// docs/DESIGN-FRAMEWORK-BRIEF.md, BUILD-SPEC.md §"Phase 12b + 13 —
// specced from Aria's briefs" / "12b Design Framework".
//
// Deliberately kept out of types/index.ts (protected — this task's
// working-copy boundary explicitly excludes it) — follows the exact
// same per-feature-file convention established by
// types/phase-12a-a.ts, types/phase-12a-b.ts, types/phase-13.ts and
// types/phase-fix-a.ts: every type below is scoped to this feature's
// own files (app/api/projects/[id]/design/**,
// app/api/design-phases/**, app/api/design-tasks/**,
// components/projects/design/**) and imported from here instead of
// types/index.ts.
//
// Cross-imports from types/index.ts are READ-ONLY reuse of existing,
// already-defined shapes — nothing in types/index.ts is modified.
// ============================================================

import type { Profile } from "@/types";

/** Lightweight profile summary for an assignee chip — same shape as phase-12a-b's AssigneeSummary / phase-13's OfficeAssigneeSummary. */
export type DesignAssigneeSummary = Pick<Profile, "id" | "full_name">;

/**
 * Team roster entry as returned by GET /api/projects/[id]/design's
 * `team` array — DesignAssigneeSummary plus `email`, mirroring
 * types/phase-13.ts's exact OfficeTeamMember pattern, so the
 * `create_design_task` MCP tool can resolve an `assignee_email`
 * argument to a profile id from this same response (this codebase has
 * no standalone GET /api/profiles listing route). Design tab UI code
 * only ever needs id/full_name and simply ignores the extra field.
 */
export type DesignTeamMember = DesignAssigneeSummary & { email: string };

export type DesignPhaseStatus = "not_started" | "in_progress" | "complete" | "na";

/**
 * The brief's fixed 7-phase order (docs/DESIGN-FRAMEWORK-BRIEF.md
 * "Board Phases (Groups in Order)") — Sampling and Furniture (two
 * separate Monday groups on the real board) are combined into one
 * "Sampling & Furniture" phase here per BUILD-SPEC.md's own task brief
 * wording, which supersedes the Monday board's two-group layout for
 * this lighter-weight spec-system checklist. Seeded verbatim, in this
 * exact order, by GET /api/projects/[id]/design on a project's first
 * Design-tab visit (see that route's doc comment) — kept here as the
 * single shared source both the API seed logic and any future
 * "restore defaults" action read from, mirroring
 * OFFICE_DEFAULT_GROUPS's exact role in types/phase-13.ts.
 *
 * Fixed order, NOT reorderable (BUILD-SPEC.md: "Phases reorderable? No
 * — fixed brief order, keep simple") — no route in this feature exposes
 * a phase reorder action.
 */
export const DESIGN_PHASE_TEMPLATE = [
  "Project Milestones",
  "Presentation",
  "Concepts",
  "3D Working Model",
  "WD Package",
  "Renders",
  "Sampling & Furniture",
] as const;

/** The one phase name the WD-Package hinge (BUILD-SPEC.md "completing WD Package prompts SOW + estimate version creation") watches for. Exact string match against design_phases.name — see app/api/design-phases/[id]/route.ts PATCH. */
export const WD_PACKAGE_PHASE_NAME = "WD Package";

export interface DesignPhase {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  status: DesignPhaseStatus;
  started_at: string | null;
  completed_at: string | null;
  hinge_dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignTask {
  id: string;
  design_phase_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  sort: number;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A design_tasks row annotated with its assignees — the shape every Design tab API response and the UI work with. */
export interface DesignTaskWithAssignees extends DesignTask {
  assignees: DesignAssigneeSummary[];
}

/** A design_phases row with its (non-deleted) tasks nested — the Design tab's per-phase vertical section. */
export interface DesignPhaseWithTasks extends DesignPhase {
  tasks: DesignTaskWithAssignees[];
}

/** GET /api/projects/[id]/design response — one fetch renders the whole Design tab, same shape as GET /api/office / GET /api/projects/[id]/board. `team` carries `email` too (DesignTeamMember) for the create_design_task MCP tool's assignee_email resolution; the Design tab UI itself only reads id/full_name from it, same as DesignAssigneeSummary. */
export interface DesignFrameworkResponse {
  phases: DesignPhaseWithTasks[];
  team: DesignTeamMember[];
}

/** body accepted by PATCH /api/design-phases/[id]. */
export interface PatchDesignPhaseInput {
  status?: DesignPhaseStatus;
  /** Dismisses the WD-Package hinge prompt for this phase row (stamps hinge_dismissed_at) — see that route's doc comment. Only meaningful on the "WD Package" phase; harmlessly ignored elsewhere. */
  hinge_dismissed?: boolean;
}

/** body accepted by POST /api/design-tasks. */
export interface CreateDesignTaskInput {
  design_phase_id: string;
  title: string;
  description?: string | null;
  due_date?: string | null;
  /** Omit to auto-assign the creator (mirrors Board v2 / Office board's exact auto-assign-on-create rule); pass [] explicitly for "no assignees"; pass one or more profile ids to override. */
  assignee_ids?: string[];
}

/** body accepted by PATCH /api/design-tasks/[id]. */
export interface PatchDesignTaskInput {
  title?: string;
  description?: string | null;
  due_date?: string | null;
  sort?: number;
  assignee_ids?: string[];
  /** true = mark complete (stamps completed_at); false = uncomplete (clears it). Omit to leave completion state untouched. */
  complete?: boolean;
}

/**
 * Compact per-phase progress used by the Design tab's phase chip
 * ("3/5 tasks") and the Overview card's status dots — derived, not
 * stored; computed by lib/design-framework.ts's phaseProgress() from a
 * DesignPhaseWithTasks so the same math can never drift between the
 * Design tab and the Overview card.
 */
export interface DesignPhaseProgress {
  phase_id: string;
  name: string;
  status: DesignPhaseStatus;
  done_count: number;
  total_count: number;
}

/** Overview integration (additive) — GET /api/projects/[id]/design also folds this summary in, consumed by components/projects/DesignProgressCard.tsx. */
export interface DesignOverviewSummary {
  phases: DesignPhaseProgress[];
}
