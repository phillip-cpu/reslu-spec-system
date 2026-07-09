// ============================================================
// RESLU Spec System — Site-visit lifecycle emails
// Types for the email_sends log (migration 043_visit_emails.sql) and
// its one read route (GET /api/visit-emails). Kept in its own file per
// this codebase's house convention of one types/round-*.ts file per
// round, rather than editing the shared types/index.ts (out of this
// round's edit boundary).
// ============================================================

export type VisitEmailRecordType = "lead" | "client_event";

/** Matches an emails/*.html filename (without extension) 1:1 — see
 * lib/visit-emails.ts's loadTemplate(). Free text in the DB (not a
 * fixed union) so a future milestone template needs no migration, but
 * today only these two exist. */
export type VisitEmailTemplateName = "visit-confirmation" | "visit-reminder";

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
}
