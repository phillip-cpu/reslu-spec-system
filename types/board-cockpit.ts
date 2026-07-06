// ============================================================
// RESLU Spec System — Board cockpit round LOCAL types (7 July 2026).
// BUILD-SPEC.md "Board refinement batch (Phillip screenshots, 7 July
// 2026)" + the four chat-agreed improvements: book-trade-from-card
// (visit_id + live status badge), milestone cards (kind + diary
// prompt), phase task templates (app_settings 'phase_task_templates'),
// Aria booking-chase attention feed ('bookings_overdue'), shared
// ContactPicker, Gantt tick markers, two-dates-per-card.
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's own file-boundary list) or types/phase-12a-b.ts (a prior
// round's own file, not this one's to edit) — follows the exact same
// per-round-own-file convention every phase-N.ts / round-*.ts file in
// this directory already uses (see types/phase-fix-a.ts's header
// comment for the fullest statement of the rationale). Every type
// below is scoped to this round's own files (migration 029,
// components/board/ProjectBoard.tsx, components/gantt/GanttChart.tsx,
// components/shared/ContactPicker.tsx, app/api/board-tasks/**,
// app/api/projects/[id]/board/**, app/api/bookings/attention,
// mcp/src/index.mjs, components/settings/PhaseTaskTemplateSettings.tsx)
// and imported from here instead.
//
// Cross-imports from types/index.ts / types/phase-12a-b.ts are
// READ-ONLY reuse of existing, already-defined shapes — nothing in
// either file is modified.
// ============================================================

import type { BoardColumn, ContactSummary } from "@/types";
import type { AssigneeSummary, BoardGroup, BoardTaskWithAssignees } from "@/types/phase-12a-b";
import type { VisitStatus } from "@/lib/trade-visits";

// ------------------------------------------------------------
// board_tasks additions (migration 029): kind, visit_id,
// booking_date/booking_end_date.
// ------------------------------------------------------------

export type BoardTaskKind = "task" | "milestone";

/** Lightweight live-status projection of the linked trade_visits row — just enough for the card's status badge, not the full visit shape (that lives in lib/trade-visits.ts's TradeVisit, used by the Timeline/visits surfaces). */
export interface LinkedVisitSummary {
  id: string;
  status: VisitStatus;
  start_date: string;
  end_date: string;
  contact: ContactSummary | null;
}

/**
 * A BoardTaskWithAssignees (types/phase-12a-b.ts, Phase 12a-B) extended
 * with this round's additions. Layered as an intersection rather than
 * edited onto that interface directly — that file belongs to a prior,
 * already-completed round; extending here keeps this round's edit
 * surface to its own files only, same discipline every prior
 * round-boundary file in this directory already follows.
 */
export type BoardTaskCockpit = BoardTaskWithAssignees & {
  kind: BoardTaskKind;
  visit_id: string | null;
  booking_date: string | null;
  booking_end_date: string | null;
  /** Populated by GET /api/projects/[id]/board when visit_id is set — null otherwise (including when the linked visit was soft-deleted, per migration 029's ON DELETE SET NULL — visit_id itself would already be null in that case, so this is simply never populated without a live visit_id). */
  visit: LinkedVisitSummary | null;
};

/** body accepted by POST /api/board-tasks/[id]/book-visit. Either books a brand new trade_visits row (phase_id + dates required) or links an already-existing one (existing_visit_id) — never both. */
export type BookVisitInput =
  | {
      phase_id: string;
      contact_id?: string | null;
      start_date: string;
      end_date: string;
      arrival_slot?: "first_thing" | "midday" | "afternoon" | null;
      arrival_time?: string | null;
      notes?: string | null;
    }
  | { existing_visit_id: string };

export interface BookVisitResponse {
  task: BoardTaskCockpit;
}

/** body accepted by PATCH /api/board-tasks/[id] — this round adds kind (milestone toggle) on top of Phase 12a-B's PatchBoardTaskInputV2 fields. Booking_date/booking_end_date/visit_id are NOT independently PATCHable here — they are only ever set via POST .../book-visit or cleared via DELETE .../book-visit (see that route's doc comment) so a card's booking state always has a single, auditable write path rather than two ways to set the same fields. */
export interface PatchBoardTaskCockpitInput {
  kind?: BoardTaskKind;
}

// ------------------------------------------------------------
// GET /api/projects/[id]/board response, cockpit-flavoured — same
// shape as Phase 12a-B's BoardV2Response (types/phase-12a-b.ts) but
// with every task carrying this round's BoardTaskCockpit fields
// instead of the plain BoardTaskWithAssignees. Defined here (not by
// editing that file, a prior completed round's own file) so this
// round's edit surface stays to its own files; structurally these are
// simply BoardV2Response with a richer `tasks` array on each
// column/group, so existing code reading only the Phase 12a-B fields
// off a response typed this way keeps compiling unchanged.
// ------------------------------------------------------------

export interface BoardColumnCockpit extends BoardColumn {
  tasks: BoardTaskCockpit[];
}

export interface BoardGroupCockpit extends BoardGroup {
  tasks: BoardTaskCockpit[];
  phase_start_date: string | null;
  phase_end_date: string | null;
}

export interface BoardV2CockpitResponse {
  columns: BoardColumnCockpit[];
  groups: BoardGroupCockpit[];
  team: AssigneeSummary[];
}

// ------------------------------------------------------------
// Milestone-complete diary prompt
// ------------------------------------------------------------

/** body accepted by POST /api/projects/[id]/client-updates/posts when created from the milestone-complete prompt — same shape that route already accepts (photo_ids omitted; a milestone completion has no photos of its own to attach at creation time — staff can add them from the Diary panel afterwards like any other draft). */
export interface MilestoneDiaryDraftInput {
  title: string;
  body_richtext?: string;
}

// ------------------------------------------------------------
// Phase task templates — app_settings key 'phase_task_templates'
// (migration 029).
// ------------------------------------------------------------

export type PhaseTaskTemplateKind = "task" | "milestone";

export interface PhaseTaskTemplateRow {
  title: string;
  kind: PhaseTaskTemplateKind;
}

/** The full app_settings('phase_task_templates') value — an object keyed by phase-template NAME (matching app_settings('phase_template') row names, e.g. "Demolition") -> its task checklist. See migration 029's PART 2 comment for why name (not an id) is the key. */
export type PhaseTaskTemplatesMap = Record<string, PhaseTaskTemplateRow[]>;

/** GET /api/settings/phase-task-templates response. */
export interface PhaseTaskTemplatesResponse {
  templates: PhaseTaskTemplatesMap;
}

/** body accepted by PUT /api/settings/phase-task-templates — full replace, admin-only (mirrors PUT /api/settings/phase-template's exact gating). */
export interface PutPhaseTaskTemplatesInput {
  templates: PhaseTaskTemplatesMap;
}

// ------------------------------------------------------------
// Aria booking-chase attention feed — 'bookings_overdue'
// ------------------------------------------------------------

/** One overdue-booking row — a board_tasks card whose booking_date has passed with the linked visit still unconfirmed/tentative, OR a milestone card whose due_date has passed while incomplete. Kept as a single flat shape (rather than two separate lists) since both are "a card Aria should chase," differentiated only by `reason`. */
export interface BookingsOverdueItem {
  task_id: string;
  title: string;
  project_id: string;
  project_name: string;
  reason: "booking_unconfirmed" | "milestone_overdue";
  /** The date that made this overdue — booking_date for booking_unconfirmed, due_date for milestone_overdue. */
  date: string;
  visit_status: VisitStatus | null;
  contact: ContactSummary | null;
}

/** GET /api/board-tasks/attention response — mirrors GET /api/visits/attention's exact shape convention (a thin route + a lib/*.ts pure compute function), see lib/my-work.ts's bookingsOverdue() (this round). */
export interface BookingsOverdueResponse {
  bookings_overdue: BookingsOverdueItem[];
}

// ------------------------------------------------------------
// Shared ContactPicker (components/shared/ContactPicker.tsx)
// ------------------------------------------------------------

/** Minimal contact projection the shared picker needs to render + filter its searchable list — a subset of the full Contact shape (types/index.ts), same "lean projection for a list/picker" convention as ContactSummary itself. */
export interface ContactPickerOption {
  id: string;
  company: string;
  contact_name: string | null;
  trade_type?: string | null;
}

export interface ContactPickerProps {
  contacts: ContactPickerOption[];
  selectedId: string | null;
  onSelect: (contactId: string | null) => void;
  /** Optional — shown as the trigger button's label when nothing is selected. Defaults to "Link contact". */
  placeholder?: string;
  /** Optional — when true, shows a "No link" option to clear the selection (default true, matching every existing ad-hoc picker's behaviour). */
  clearable?: boolean;
  /**
   * Board cockpit round — item 6: an ALWAYS-open, embedded rendering
   * mode (no trigger button, no internal open/close state) for callers
   * that already render their own "panel is open" shell around an
   * inline contact picker — e.g. components/estimate/ContactLinkPicker.tsx,
   * which shows a header + search box + list directly inside an
   * already-expanded table row, not behind a second click. Defaults to
   * false (the normal button+dropdown mode every other call site
   * uses). When true, `onClose` becomes required (the embedding
   * caller owns "close", exactly like ContactLinkPicker's own prop of
   * the same name already did before this round) — search box +
   * filtered list + keyboard nav are otherwise byte-for-byte the same
   * code path as the popover mode, just always visible instead of
   * behind a button.
   */
  embedded?: boolean;
  /** Required when `embedded` is true — see that prop's doc comment. Ignored in normal (button+dropdown) mode. */
  onClose?: () => void;
}

// ------------------------------------------------------------
// Gantt tick markers — board_tasks due_date/booking_date shown on the
// Timeline, plus milestone diamonds. See components/gantt/
// GanttChart.tsx's marker rendering — a pure, absolutely-positioned,
// pointer-events-none layer following the EXACT same pattern as its
// existing "today line" marker, so drag math (lib/phase-drag.ts,
// GanttChart.tsx's pointer handlers) is never touched.
// ------------------------------------------------------------

export type GanttTimelineMarkerKind = "milestone" | "due_date" | "booking_date";

/** One marker to render on the Gantt timeline — a single date, positioned via lib/gantt.ts's existing phaseGridPosition() (same grid math as phase bars / the today line), inside the phase row it belongs to (matched by phase_group_id -> board_groups.phase_id, same linkage Round A's "Board owns dates" already relies on). */
export interface GanttTimelineMarker {
  task_id: string;
  title: string;
  kind: GanttTimelineMarkerKind;
  date: string;
  /** The schedule_phases id this marker's row belongs to (via board_tasks.phase_group_id -> board_groups.phase_id) — null if the card isn't in any phase group, in which case it renders in a shared "unphased" markers row rather than being dropped silently. */
  phase_id: string | null;
}

// ------------------------------------------------------------
// Materials price-refresh chase — 'price_refreshes_pending' attention
// feed (migration 029 PART 3: materials.price_refresh_status/
// price_refresh_requested_at). Companion to BookingsOverdueResponse
// above — same shape convention.
// ------------------------------------------------------------

export interface MaterialNeedingAriaItem {
  material_id: string;
  name: string;
  requested_at: string;
}

/** GET /api/materials/attention response. */
export interface MaterialsNeedingAriaResponse {
  price_refreshes_pending: MaterialNeedingAriaItem[];
}

// Re-exported for callers that only need the assignee shape alongside
// this round's own types (avoids a second import statement at call
// sites that already import from this file for the cockpit types
// above).
export type { AssigneeSummary };
