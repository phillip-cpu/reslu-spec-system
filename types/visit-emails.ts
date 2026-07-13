// ============================================================
// RESLU Spec System — Site-visit lifecycle emails
// Types for the email_sends log (migration 043_visit_emails.sql) and
// its one read route (GET /api/visit-emails). Kept in its own file per
// this codebase's house convention of one types/round-*.ts file per
// round, rather than editing the shared types/index.ts (out of this
// round's edit boundary).
// ============================================================

// Grouped trade booking round (r20) — 'trade_booking_request' added.
// record_id points at trade_booking_requests.id for BOTH the initial
// grouped-request send and the admin "keep original + reply" short
// reply — see migration 049's own email_sends.record_type comment.
// (The DB's own CHECK constraint also allows 'client_invoice' — see
// migration 046 — but that send path writes email_sends directly,
// never through this module/type, so it's deliberately not listed
// here; this type only ever needs to cover values THIS module's own
// sendOrQueue()/flushPendingSends() actually read/write.)
export type VisitEmailRecordType = "lead" | "client_event" | "trade_booking_request";

/** Matches an emails/*.html filename (without extension) 1:1 — see
 * lib/visit-emails.ts's loadTemplate(). Free text in the DB (not a
 * fixed union) so a future milestone template needs no migration.
 * Grouped trade booking round (r20) additions: 'trade-booking-request'
 * (the grouped-send email) and 'trade-booking-reply' (the admin's
 * short "keep original + reply" note — see POST
 * /api/trade-requests/[id]/lines/[visitId]/resolve). */
export type VisitEmailTemplateName =
  | "visit-confirmation"
  | "visit-reminder"
  | "trade-booking-request"
  | "trade-booking-reply";

export type VisitEmailStatus = "pending" | "sent" | "skipped";

/** Merge-data snapshot stored on every email_sends row (see migration
 * 043's own "detail jsonb" doc comment for the full guard-semantics
 * write-up). All optional — a 'skipped' row logged before the template
 * even loaded may carry only a subset. */
export interface VisitEmailDetail {
  first_name?: string | null;
  last_name?: string | null;
  visit_date?: string | null;
  visit_time?: string | null;
  suburb?: string | null;
  phillip_phone?: string | null;
  subject?: string | null;
  /** ISO timestamp of the visit this send/queue attempt was for — the
   * re-send guard's comparison key. */
  visit_datetime?: string | null;
  /** Present only on a 'skipped' row — human-readable reason. */
  reason?: string | null;
  /** Lead flow round (048) — the Google Calendar "render" URL merged
   * into {{calendar_link}}. See lib/ics.ts's leadVisitGoogleCalendarUrl(). */
  calendar_link?: string | null;
  /** Lead flow round (048) — the tokenised /brief/[token] URL merged
   * into visit-reminder.html's {{brief_link}}. */
  brief_link?: string | null;
  /** Lead flow round (048) — the invite.ics Resend attachment(s) for
   * this send, base64-encoded (no `data:` prefix — see
   * lib/resend.ts's ResendAttachment). Carried inside `detail` (rather
   * than only passed at the original sendOrQueue() call) so a QUEUED
   * row's later flush (lib/visit-emails.ts's flushPendingSends, which
   * re-renders/re-sends from `detail` alone, never a second live call)
   * still has the attachment to re-send with. Absent for the
   * client_events reminder path (never generates one). */
  attachments?: { filename: string; content: string }[] | null;
  /** Grouped trade booking round (r20) — trade-booking-request.html / trade-booking-reply.html placeholders. All blank-safe (merge()'s existing "missing key = empty string" contract), never referenced by the two lead-visit templates above. */
  company?: string | null;
  project_name?: string | null;
  project_address?: string | null;
  /** Pre-built HTML `<tr>` rows (lib/trade-booking.ts's buildTaskRowsHtml()) — merged verbatim into {{task_rows}}, not further escaped by merge() itself. */
  task_rows?: string | null;
  request_link?: string | null;
  attachments_note?: string | null;
  /** trade-booking-reply.html only — the admin's short "keep original" note. */
  message?: string | null;
}

export interface EmailSendRow {
  id: string;
  record_type: VisitEmailRecordType;
  record_id: string;
  template: VisitEmailTemplateName;
  to_email: string;
  status: VisitEmailStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  detail: VisitEmailDetail;
  created_at: string;
}

/** GET /api/visit-emails?record_type=&record_id= response. */
export interface EmailSendsResponse {
  sends: EmailSendRow[];
}

/** GET/POST /api/visit-emails/run response. */
export interface VisitEmailsRunResult {
  flushed: { sent: number; skipped: number; failed: number; stillPending: number };
  reminders: { sent: number; queued: number; skipped: number };
  proposalsFlushed: { sent: number; skipped: number; failed: number; stillPending: number };
}
