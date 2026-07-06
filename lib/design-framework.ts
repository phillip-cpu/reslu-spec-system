// ============================================================
// RESLU Spec System — Design Framework shared helpers (Phase 12b)
// Pure, dependency-free helpers used by GET /api/projects/[id]/design
// (seed-on-first-visit + progress computation) and
// components/projects/DesignProgressCard.tsx (re-derives the same chip
// math client-side from an already-fetched payload) — mirrors
// lib/my-work.ts's / lib/estimate-versions.ts's established "plain data
// in, plain data out, no Supabase/Next imports" convention so the
// progress math can never drift between the Design tab and the
// Overview card.
// ============================================================

import type {
  DesignPhaseProgress,
  DesignPhaseWithTasks,
} from "@/types/phase-12b";
import { DESIGN_PHASE_TEMPLATE, WD_PACKAGE_PHASE_NAME } from "@/types/phase-12b";

/** Re-exported so callers that only need the seed list don't have to know it lives on the types file. */
export { DESIGN_PHASE_TEMPLATE, WD_PACKAGE_PHASE_NAME };

/**
 * Per-phase progress chip data ("3/5 tasks") — done_count/total_count
 * only ever counts non-deleted tasks (the caller's DesignPhaseWithTasks
 * already excludes soft-deleted rows, per
 * GET /api/projects/[id]/design's own query). A phase with zero tasks
 * shows 0/0, rendered by the UI as a plain status chip with no
 * fraction rather than "0/0" (see DesignPhaseSection.tsx).
 */
export function phaseProgress(phase: DesignPhaseWithTasks): DesignPhaseProgress {
  const total = phase.tasks.length;
  const done = phase.tasks.filter((t) => !!t.completed_at).length;
  return {
    phase_id: phase.id,
    name: phase.name,
    status: phase.status,
    done_count: done,
    total_count: total,
  };
}

/** Maps a full phase list to progress rows — used by both the API's `design` summary field and the Overview card. */
export function allPhaseProgress(phases: DesignPhaseWithTasks[]): DesignPhaseProgress[] {
  return phases.map(phaseProgress);
}

/**
 * Whether the WD-Package hinge prompt should show — BUILD-SPEC.md
 * "completing WD Package prompts SOW + estimate version creation":
 * true only when the "WD Package" phase is complete AND has not yet
 * been dismissed (hinge_dismissed_at is null). Exact-name match against
 * WD_PACKAGE_PHASE_NAME (the one phase this hinge cares about — every
 * other phase's hinge_dismissed_at is always null and irrelevant).
 */
export function shouldShowWdPackageHinge(phases: DesignPhaseWithTasks[]): boolean {
  const wdPackage = phases.find((p) => p.name === WD_PACKAGE_PHASE_NAME);
  if (!wdPackage) return false;
  return wdPackage.status === "complete" && !wdPackage.hinge_dismissed_at;
}

/** A task is overdue when it has a due_date strictly before today and is not yet completed — same "red overdue" rule as Office board / Board v2's own due-date rendering. */
export function isTaskOverdue(dueDate: string | null, completedAt: string | null, now: Date = new Date()): boolean {
  if (!dueDate || completedAt) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate + "T00:00:00") < today;
}
