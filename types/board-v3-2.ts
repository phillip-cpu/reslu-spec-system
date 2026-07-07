// ============================================================
// RESLU Spec System — Board v3.2 LOCAL types (7 July 2026 late).
// "Two-way timeline sync + reorder animation": timeline-driven writes
// to a DERIVED phase's linked group of tasks (POST
// /api/phases/[id]/shift-items, POST /api/phases/[id]/adjust-boundary)
// and the reorder-slot-animation drag state
// (components/board/ProjectBoard.tsx — no new schema/API shape needed
// for the animation itself, it's pure client state, so nothing for it
// lives here).
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's own file-boundary list) or any prior round's own types/*.ts
// file — follows the exact same per-round-own-file convention every
// phase-N.ts / round-*.ts / board-v3.ts file in this directory already
// uses (see types/phase-fix-a.ts's header comment for the fullest
// statement of the rationale). Every type below is scoped to this
// round's own files (app/api/phases/[id]/shift-items/**,
// app/api/phases/[id]/adjust-boundary/**, components/gantt/GanttChart.tsx)
// and imported from here instead.
//
// Cross-imports from types/index.ts / other round files are READ-ONLY
// reuse of existing, already-defined shapes — nothing in any of them is
// modified.
// ============================================================

/** body accepted by POST /api/phases/[id]/shift-items. */
export interface ShiftItemsInput {
  /** Whole-day delta (positive = later, negative = earlier) applied to every task's booking_date/booking_end_date in the phase's linked group. Same day-snapped delta lib/phase-drag.ts already produces for an ordinary phase drag — this route is the derived-phase equivalent commit path. */
  delta_days: number;
}

/** One task's shift outcome — either it moved cleanly, or it hit a per-task error (collected, not thrown, so one bad row can't abort the whole group's shift). */
export interface ShiftedTaskResult {
  id: string;
  booking_date: string | null;
  booking_end_date: string | null;
  ok: boolean;
  error?: string;
}

export interface ShiftItemsResponse {
  tasks: ShiftedTaskResult[];
  /**
   * board_tasks.id values whose LINKED trade_visits row was status
   * 'confirmed' at the moment of this shift — returned for API
   * consumers (e.g. Aria, or a future Board-side surfacing) that only
   * hold board_tasks ids, per BUILD-SPEC.md's literal wording "any
   * confirmed-visit ids whose dates changed."
   */
  reconfirm_task_ids: string[];
  /**
   * The SAME set, expressed as trade_visits.id instead — GanttChart.tsx
   * keys its existing "Dates changed — re-send confirmation?" affordance
   * (reconfirmPrompts, ReconfirmAffordance.tsx) by VISIT id, not task id
   * (see commitVisitDrag's identical trigger for an ordinary visit
   * sub-bar drag), and it never holds board_tasks rows locally at all —
   * only trade_visits rows via each phase's own `visits` array. Returning
   * both ids side by side lets each caller use whichever key it already
   * has, rather than one caller needing an extra lookup route just to
   * translate task id -> visit id.
   */
  reconfirm_visit_ids: string[];
  /** True when the phase itself (or its linked group) could not be found — a 404 already returned in that case, this field only appears defensively and is never actually read by callers today. */
  error?: string;
}

/** body accepted by POST /api/phases/[id]/adjust-boundary. */
export interface AdjustBoundaryInput {
  /** 'start' moves only the EARLIEST item's booking_date; 'end' moves only the LATEST item's booking_end_date (falling back to booking_date when that item has no distinct end) — boundary-item semantics, mirroring lib/phase-drag.ts's applyDrag's resize-start/resize-end modes one level down (item, not phase). */
  edge: "start" | "end";
  new_date: string;
}

export interface AdjustBoundaryResponse {
  /** The single boundary task that was actually written. */
  task: { id: string; booking_date: string | null; booking_end_date: string | null };
  /** Same convention as ShiftItemsResponse.reconfirm_task_ids — populated only when this boundary task's linked visit was 'confirmed' at the time of the adjustment (a boundary adjustment only ever touches one task, so this is at most a single-element array, kept as an array for a uniform client-side shape with shift-items). */
  reconfirm_task_ids: string[];
  /** Same convention as ShiftItemsResponse.reconfirm_visit_ids — see that field's doc comment for why GanttChart.tsx needs the visit-id form. */
  reconfirm_visit_ids: string[];
}
