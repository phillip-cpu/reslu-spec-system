// ============================================================
// RESLU Spec System — Board v3.3 LOCAL types (8 July 2026).
// "Placeholder dates + booking actually sends": works dates rejoin the
// PATCH whitelist (reversing v3.1's read-only deviation), book-visit
// sends its trade email at creation, and BookVisitPanel's card-context
// prefill gets a visible "From: {title}" trace line.
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's own file-boundary list) or any prior round's own types/*.ts
// file (types/phase-12a-b.ts, types/board-cockpit.ts, types/board-v3.ts,
// types/board-v3-2.ts) — follows the exact same per-round-own-file
// convention every phase-N.ts / round-*.ts / board-v3*.ts file in this
// directory already uses (see types/phase-fix-a.ts's header comment for
// the fullest statement of the rationale). Everything below is scoped
// to this round's own files: app/api/board-tasks/[id]/route.ts,
// app/api/board-tasks/[id]/book-visit/route.ts,
// components/board/DateCell.tsx, components/board/BookVisitPanel.tsx,
// components/board/ProjectBoard.tsx.
//
// Cross-imports from types/phase-12a-b.ts / types/board-cockpit.ts are
// READ-ONLY reuse of existing, already-defined shapes — nothing in
// either file is modified.
// ============================================================

import type { PatchBoardTaskInputV2 } from "@/types/phase-12a-b";
import type { BookVisitInput, BoardTaskCockpit } from "@/types/board-cockpit";

/**
 * body accepted by PATCH /api/board-tasks/[id] as of Board v3.3 —
 * PatchBoardTaskInputV2 (Phase 12a-B) plus this round's booking_date/
 * booking_end_date (REJOINING the whitelist — see that route's
 * EDITABLE_FIELDS doc comment for the full "reverses v3.1" story) and
 * the Board-cockpit-round's `kind`, layered as an intersection rather
 * than editing either prior file directly, per this file's own
 * edit-boundary discipline. The route itself still reads fields off
 * the plain object via `Object.entries` for the generic whitelist loop
 * (unchanged), but the two new fields are also referenced BY NAME for
 * the start<=end validation, hence needing a real type here.
 */
export type PatchBoardTaskV33Input = PatchBoardTaskInputV2 & {
  kind?: "task" | "milestone";
  booking_date?: string | null;
  booking_end_date?: string | null;
};

/** PATCH /api/board-tasks/[id] response, Board v3.3 — adds reconfirm_visit_ids (populated only when a direct booking-date edit was synced onto a CONFIRMED linked visit — see that route's WORKS-DATE / VISIT SYNC doc comment). */
export interface PatchBoardTaskV33Response {
  task: BoardTaskCockpit;
  reconfirm_visit_ids: string[];
}

// ------------------------------------------------------------
// Booking email — POST /api/board-tasks/[id]/book-visit now sends the
// trade's confirmation email at creation (Board v3.3 item 2) instead of
// staying silent until the day-before cron. Response gains email_sent/
// email_skip_reason so the UI can surface "request sent to {contact}"
// vs "booked — email not sent: {reason}" without a second round-trip.
// ------------------------------------------------------------

export type BookVisitEmailSkipReason =
  | "no_gmail_config"
  | "no_contact"
  | "no_contact_email";

/** POST /api/board-tasks/[id]/book-visit response, Board v3.3-flavoured — BookVisitResponse (types/board-cockpit.ts) plus this round's email outcome fields. */
export interface BookVisitV33Response {
  task: BoardTaskCockpit;
  insurance_warning: string | null;
  /** True only when the confirmation email actually sent (Gmail configured, a contact was linked, and that contact has an email on file). */
  email_sent: boolean;
  /** Populated whenever email_sent is false — the reason nothing went out, for the UI's "booked — email not sent: {reason}" copy. Absent (not just false) has no meaning here; always present when email_sent is false. */
  email_skip_reason?: BookVisitEmailSkipReason;
}

/** Re-exported so callers that only need the booking input shape alongside this round's own additions avoid a second import from types/board-cockpit.ts. */
export type { BookVisitInput };

// ------------------------------------------------------------
// BookVisitPanel — card-context prefill trace (item 3).
// ------------------------------------------------------------

/** Optional card-context props BookVisitPanel accepts to render its "From: {title}" trace line and lock the phase select — see that component's own doc comment for the full "why a visible affordance, not silent prefill" rationale. */
export interface BookVisitPanelCardContext {
  /** The opening card's own title — rendered verbatim as "From: {title}" so a staff member can see AT A GLANCE that this panel arrived with card context (and which card), rather than wondering whether the prefilled phase/trade/dates are a coincidence or a deliberate carry-through. */
  title: string;
}
