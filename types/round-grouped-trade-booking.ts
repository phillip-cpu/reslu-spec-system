// ============================================================
// RESLU Spec System — Grouped trade booking round (r20) LOCAL types.
// docs/BUILD-SPEC.md §"Grouped trade booking (r20)".
//
// Deliberately NOT added to types/index.ts (protected, out of this
// round's edit boundary) — same "one types/round-*.ts file per round"
// house convention every prior round's own local types file already
// follows (types/phase-12a-b.ts, types/board-v3-3.ts, types/trade-doc-
// pack.ts, types/round-lead-flow.ts, etc.). Cross-imports from other
// files are read-only reuse of already-defined shapes.
// ============================================================

import type { DocumentPackChoices } from "@/types/trade-doc-pack";

export type TradeBookingRequestStatus = "draft" | "sent" | "responded" | "closed";

/** Migration 049's trade_visits.line_status — see that column's own comment for the full state description. Null on this type is never valid for a grouped line (every row created by POST /api/projects/[id]/trade-requests always sets one) — the plain trade_visits row shape (lib/trade-visits.ts's TradeVisit) keeps line_status as `string | null` since an ORDINARY r15 visit's line_status is genuinely null forever. */
export type TradeVisitLineStatus = "proposed" | "accepted" | "date_suggested";

/** A trade_booking_requests row, verbatim. */
export interface TradeBookingRequestRow {
  id: string;
  project_id: string;
  contact_id: string | null;
  token: string;
  status: TradeBookingRequestStatus;
  sent_at: string | null;
  responded_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// GroupBookPanel (components/board/GroupBookPanel.tsx) — task
// selection.
// ------------------------------------------------------------

/** One project task, as GroupBookPanel needs it to decide eligibility + render a checkbox row. Built client-side from GET /api/projects/[id]/board's existing response (columns[].tasks + groups[].phase_id) — no new GET route for this round. */
export interface GroupableTask {
  id: string;
  title: string;
  contact_id: string | null;
  booking_date: string | null;
  booking_end_date: string | null;
  phase_group_id: string | null;
  /** Resolved client-side from the matching board_groups row's phase_id — null when the task isn't in a phase-linked group (BUILD-SPEC's "undated tasks... excluded" rule is extended here to cover "unphased" too, since a trade_visits row cannot be created without a phase_id — see GroupBookPanel's own doc comment). */
  phase_id: string | null;
  /** Already linked to a trade_visits row (e.g. booked individually via the r15 flow, or a prior grouped request) — surfaced so the panel can show "already booked" rather than silently re-booking over it. Still selectable (POST /api/projects/[id]/trade-requests re-links rather than double-books, mirroring POST /api/board-tasks/[id]/book-visit's own existing_visit_id branch). */
  visit_id: string | null;
}

/** body accepted by POST /api/projects/[id]/trade-requests — the group-mode "Send" action (BUILD-SPEC.md item 2: "Send action: POST creating the trade_booking_request + linking/creating the trade_visits (line_status 'proposed'), then ONE email"). */
export interface CreateTradeBookingRequestInput {
  contact_id: string;
  /** board_tasks ids to include as lines — every one must belong to this project, carry this same contact_id, a set booking_date/booking_end_date, and a resolvable phase_id (via its group), or it's skipped and reported in `skipped` on the response rather than failing the whole request (same per-row error-collection discipline as POST /api/phases/[id]/shift-items). */
  task_ids: string[];
  /** Frozen "Include documents" choices, applied identically to every line's trade_visits.document_pack — same shape/freeze-at-send-time semantics as BookVisitPanel's single-visit document_pack (migration 032). Omitted entirely when nothing is ticked, same "omitted, not an all-false object" contract as the r15 panel. */
  document_pack?: DocumentPackChoices;
}

export interface CreateTradeBookingRequestSkippedTask {
  task_id: string;
  reason: "no_booking_dates" | "no_phase" | "wrong_contact" | "not_found" | "already_in_open_request";
}

/** POST /api/projects/[id]/trade-requests response. */
export interface CreateTradeBookingRequestResponse {
  request: TradeBookingRequestRow;
  visit_ids: string[];
  skipped: CreateTradeBookingRequestSkippedTask[];
  email_sent: boolean;
  email_skip_reason?: string;
}

// ------------------------------------------------------------
// Request detail (admin) — GET /api/trade-requests/[id].
// ------------------------------------------------------------

export interface TradeBookingRequestLine {
  /** trade_visits.id */
  id: string;
  task_id: string | null;
  task_title: string;
  phase_id: string;
  phase_name: string;
  start_date: string;
  end_date: string;
  /** The existing r15 trade_visits.status (unconfirmed/confirmed/tentative/declined/proposed_change) — kept alongside line_status so the admin detail view can show both the grouped-flow state AND whatever the existing per-visit machinery (reminders, "who else is on site") currently has it as. */
  status: string;
  line_status: TradeVisitLineStatus;
  suggested_start: string | null;
  suggested_end: string | null;
  response_note: string | null;
}

export interface TradeBookingRequestDetail {
  request: TradeBookingRequestRow;
  project: { id: string; name: string } | null;
  contact: { id: string; company: string; contact_name: string | null; email: string | null } | null;
  lines: TradeBookingRequestLine[];
}

// ------------------------------------------------------------
// Public response page — /trade-request/[token].
// ------------------------------------------------------------

/** body accepted by POST /api/trade-request/[token]/respond. */
export type TradeRequestRespondInput =
  | { action: "accept"; line_id: string }
  | {
      action: "suggest";
      line_id: string;
      suggested_start: string;
      suggested_end: string;
      response_note?: string | null;
    };

// ------------------------------------------------------------
// Admin line resolution — POST /api/trade-requests/[id]/lines/[visitId]/resolve.
// ------------------------------------------------------------

/** BUILD-SPEC.md item 4/5's two admin actions on a 'date_suggested' line. accept_shift applies the trade's suggested dates to the line (and its linked board_task) and offers the existing shift-items ripple for the rest of that phase; keep_reply frees the line back to 'proposed' and optionally sends a short reply. */
export type ResolveTradeLineInput =
  | { action: "accept_shift" }
  | { action: "keep_reply"; message?: string | null };

export interface ResolveTradeLineResponse {
  line: TradeBookingRequestLine;
  /** Present only for accept_shift, and only when the line's phase group has OTHER tasks with booking dates to shift alongside it — the admin UI's own explicit follow-up call to the EXISTING POST /api/phases/[id]/shift-items route (never reimplemented here). Null when there's nothing else in the phase to offer shifting. */
  shift_offer: { phase_id: string; delta_days: number } | null;
  email_sent?: boolean;
  email_skip_reason?: string;
}
