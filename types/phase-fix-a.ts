// ============================================================
// RESLU Spec System — Fix Round A LOCAL types
// Phase unification (board_groups <-> schedule_phases), pre-populated
// phase template (app_settings), vertical board layout (view-toggle
// persistence — no new shared shape beyond what's here), trade
// insurance tracker additions to Contact.
//
// Deliberately NOT added to types/index.ts (protected — see this
// task's own boundary notes) or types/phase-12a-b.ts (owned by the
// concurrent Phase 12a-B build, not this task) — follows the exact
// same per-feature-file convention established by
// types/phase-12a-a.ts, types/phase-12a-b.ts and types/phase-13.ts:
// every type below is scoped to this round's own files
// (app/api/projects/[id]/phases/**, app/api/projects/[id]/board/
// groups/**, app/api/contacts/**, app/api/contact-documents/**,
// components/board/ProjectBoard.tsx, components/gantt/GanttChart.tsx,
// app/(dashboard)/settings/page.tsx) and imported from here instead.
//
// Cross-imports from types/index.ts / types/phase-12a-b.ts are
// READ-ONLY reuse of existing, already-defined shapes — nothing in
// either file is modified.
// ============================================================

import type { Contact, PhaseColorKey, SchedulePhaseWithContact } from "@/types";
import type { ContactDocument, InsuranceStatus } from "@/lib/insurance";

// ------------------------------------------------------------
// Phase unification — board_groups.phase_id (migration 023)
// ------------------------------------------------------------
//
// NOTE: board_groups.phase_id itself is typed directly on the base
// BoardGroup interface in types/phase-12a-b.ts (not layered on here as
// a separate BoardGroupWithPhase type) — see that file's own comment
// on the `phase_id` field for why. Every BoardGroup/BoardGroupWithTasks
// value already carries it.

/**
 * A schedule_phases row (as returned by GET /api/projects/[id]/phases,
 * which already merges in Phase 11A's kind/cost_section_id/visits via
 * lib/trade-visits.ts's SchedulePhaseWithVisits — this type layers
 * this round's OWN addition, board_group_id, on top without needing to
 * edit that other file) annotated with the linked board_groups row's
 * id, so the Timeline UI can show/deep-link "also a board group" and
 * so renaming from the Timeline side knows which board_groups row to
 * mirror the name into (see PATCH /api/phases/[id]'s updated doc
 * comment).
 */
export type SchedulePhaseWithBoardGroup = SchedulePhaseWithContact & {
  kind: "phase" | "umbrella";
  board_group_id: string | null;
  /** True when this phase was auto-created by migration 023's board-group backfill and still has placeholder (today=today) dates — see lib/phase-template.ts's phaseNeedsDatesFlag(). Derived from `notes` by the API route, not stored as its own column. */
  needs_dates: boolean;
};

export interface PhasesListResponseWithGroups {
  phases: SchedulePhaseWithBoardGroup[];
}

/** body accepted by POST /api/projects/[id]/phases (this round: unchanged fields, but the route now ALSO creates/links a board_groups row — see that route's doc comment for the invariant). */
export interface CreatePhaseInputFixA {
  name: string;
  start_date: string;
  end_date: string;
  color_key?: PhaseColorKey;
  contact_id?: string | null;
  notes?: string | null;
}

// ------------------------------------------------------------
// Pre-populated phase template (app_settings key 'phase_template')
// ------------------------------------------------------------

export interface AppSettingsPhaseTemplateRow {
  name: string;
  kind: "phase" | "umbrella";
}

/** GET /api/settings/phase-template response. */
export interface PhaseTemplateResponse {
  template: AppSettingsPhaseTemplateRow[];
}

/** body accepted by PUT /api/settings/phase-template — full replace, admin-only (mirrors PATCH /api/categories/[id]'s admin gating — this is studio-wide configuration, not per-project data). */
export interface PutPhaseTemplateInput {
  template: AppSettingsPhaseTemplateRow[];
}

// ------------------------------------------------------------
// Trade insurance tracker
// ------------------------------------------------------------

/** Contact extended with its computed insurance_status + document count — GET /api/contacts response shape (this round's addition). */
export type ContactWithInsuranceStatus = Contact & {
  insurance_status: InsuranceStatus;
  document_count: number;
};

/** GET /api/contacts/[id]/documents response. */
export type ContactDocumentWithUrl = ContactDocument & { url: string | null };

export interface ContactDocumentsResponse {
  documents: ContactDocumentWithUrl[];
}

/**
 * GET /api/contacts/attention response — mirrors LeadsAttentionResponse's
 * exact shape (types/index.ts) for the sibling trades/insurance panel.
 * Re-exports lib/insurance.ts's InsuranceAttentionGroups (the lean
 * {id, company, category, insurance_status} shape the attention feed
 * actually needs) rather than the heavier Contact-extending
 * ContactWithInsuranceStatus above (which GET /api/contacts's LIST
 * response needs, since it renders full contact cards) — the attention
 * panel only ever shows company name + status per row, not a full
 * card.
 */
export type { InsuranceAttentionGroups as ContactsAttentionResponse } from "@/lib/insurance";

// ------------------------------------------------------------
// Vertical board layout — localStorage-persisted view preference
// ------------------------------------------------------------

/** The two board layout modes — BUILD-SPEC.md "Board vertical layout": "Vertical becomes the DEFAULT layout; the side-by-side kanban stays available via a small layout toggle (persist per user in localStorage)." */
export type BoardLayoutMode = "stacked" | "side-by-side";

/**
 * MUST be exactly 'reslu-board-layout' — this task's brief pins the
 * literal key string so this toggle and the OFF-LIMITS
 * components/items/ProcurementBoardView.tsx (owned by a concurrent
 * task) read/write the SAME localStorage entry and stay in sync.
 * ProcurementBoardView.tsx's own local BOARD_LAYOUT_STORAGE_KEY
 * constant (defined independently there, not imported from here,
 * since that file is off-limits to this task) already uses this exact
 * string — do not change this value without also updating that file.
 */
export const BOARD_LAYOUT_STORAGE_KEY = "reslu-board-layout";
