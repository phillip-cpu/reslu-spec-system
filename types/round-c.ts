// ============================================================
// RESLU Spec System — Round C LOCAL types (7 July 2026, second round
// that day — "visit sub-bars, m² rate, design templates").
// BUILD-SPEC.md "Internal timeline — trade visit sub-bars" +
// "Two from Phillip — 7 July 2026" item 2 ("Design board tasks
// pre-populated from the Monday template").
//
// Same isolation convention every phase-N.ts / round-*.ts file in this
// directory already follows (see types/round-b.ts's own header comment
// for the fullest statement of the rationale): types/index.ts and
// types/phase-12b.ts are NOT edited by this round (phase-12b.ts is a
// prior, already-completed round's own file; types/index.ts is this
// round's protected file per the task brief's DO-NOT-TOUCH list) — any
// shape needed only by this round's own files lives here instead and
// is imported directly from this module.
//
// Cross-imports from lib/trade-visits.ts / types/phase-12b.ts /
// types/board-cockpit.ts below are READ-ONLY reuse of existing,
// already-defined shapes — nothing in any of those files is modified.
// ============================================================

import type { VisitStatus } from "@/lib/trade-visits";

// ------------------------------------------------------------
// Design task templates — app_settings key 'design_task_templates'.
// Deliberate structural mirror of types/board-cockpit.ts's
// PhaseTaskTemplateRow/PhaseTaskTemplatesMap (the existing
// 'phase_task_templates' key) — same editor pattern, same seed-once-
// on-first-visit mechanism, one level simpler (design task template
// rows are title-only: the Design tab's design_tasks have no
// kind/milestone concept the way board_tasks do, see
// types/phase-12b.ts's DesignTask — just title/description/due_date).
// ------------------------------------------------------------

export interface DesignTaskTemplateRow {
  title: string;
}

/**
 * The full app_settings('design_task_templates') value — an object
 * keyed by design-phase NAME (matching types/phase-12b.ts's
 * DESIGN_PHASE_TEMPLATE entries exactly, e.g. "3D Working Model") ->
 * its seed task list. Seed content sourced from
 * docs/DESIGN-FRAMEWORK-BRIEF.md's "What Currently Happens at Each
 * Phase" section — see lib/design-task-templates.ts's
 * FALLBACK_DESIGN_TASK_TEMPLATES for the exact extracted titles and
 * the doc comment marking them as editable starting points from the
 * Monday board, not a fixed/authoritative checklist.
 */
export type DesignTaskTemplatesMap = Record<string, DesignTaskTemplateRow[]>;

/** GET /api/settings/design-task-templates response. */
export interface DesignTaskTemplatesResponse {
  templates: DesignTaskTemplatesMap;
}

/** body accepted by PUT /api/settings/design-task-templates — full replace, admin-only (mirrors PUT /api/settings/phase-task-templates' exact gating — same studio-wide-configuration trust tier). */
export interface PutDesignTaskTemplatesInput {
  templates: DesignTaskTemplatesMap;
}

// ------------------------------------------------------------
// Trade visit sub-bars — BUILD-SPEC.md "Internal timeline — trade
// visit sub-bars". Grid/rendering-only additions; trade_visits itself
// (migration 016) is unchanged, no new columns.
// ------------------------------------------------------------

/**
 * Per-project expand/collapse memory for the phase-row chevrons this
 * round adds, persisted to localStorage (never the server — purely a
 * client display preference, same tier as e.g. a collapsed sidebar
 * state) under a key scoped by projectId (see
 * components/gantt/GanttChart.tsx's VISIT_EXPANSION_STORAGE_KEY
 * helper) so two different projects' expand states never collide in
 * the same browser.
 */
export type VisitExpansionState = Record<string, boolean>;

/**
 * Non-blocking affordance state for "dates changed — re-send
 * confirmation?" — shown on a visit sub-bar immediately after a
 * successful drag/resize PATCH, ONLY when the visit's status was
 * 'confirmed' at the moment the drag started (BUILD-SPEC.md: "silently
 * moving a confirmed trade's dates without re-confirming is how
 * no-shows happen"). Purely client-side transient UI state — nothing
 * here is persisted; dismissing or acting on it just clears this.
 */
export interface VisitReconfirmPrompt {
  visitId: string;
}
