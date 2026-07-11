// ============================================================
// RESLU Spec System — Grouped trade booking round (r20). Pure, plain-
// data-in/plain-data-out domain helpers — no Supabase/Next imports —
// mirroring lib/trade-visits.ts's own shape so this round's date math
// and state checks can never drift between server and client, and are
// unit-testable in isolation.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

/** Whole days between two date-only (yyyy-mm-dd) strings, `to` minus `from` (positive = `to` is later). */
export function diffDays(from: string, to: string): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / DAY_MS);
}

/**
 * BUILD-SPEC.md item 6: "No response after 3 days -> follow-up flag on
 * the request." True when the request has been sent (status='sent' —
 * a request that's already 'responded'/'closed' never needs chasing,
 * and a 'draft' was never sent in the first place) and `sent_at` is
 * more than 3 whole days before `now`.
 */
export function isBookingRequestFollowupDue(
  request: { status: string; sent_at: string | null },
  now: Date = new Date()
): boolean {
  if (request.status !== "sent" || !request.sent_at) return false;
  const sentAt = new Date(request.sent_at);
  const dueAt = new Date(sentAt.getTime() + 3 * DAY_MS);
  return now.getTime() > dueAt.getTime();
}

/**
 * BUILD-SPEC.md item 4: "When all lines resolved -> request status
 * 'responded'." A line is "resolved" (from the TRADE's point of view —
 * they've given an answer) once its line_status is anything other than
 * 'proposed' — 'accepted' or 'date_suggested' both count; a suggested-
 * date line may still need STAFF follow-up, but nothing is awaiting
 * the trade any more. Deleted (soft-deleted) lines are excluded from
 * the check — a line removed from the board mid-flight should never
 * block a request from ever reaching 'responded'. An empty `lines`
 * array returns false (nothing to be "all resolved" about — should
 * not happen in practice, since a request is only ever created with
 * at least one line, but this is the safe default).
 */
export function allLinesResolved(
  lines: { line_status: string | null; deleted_at?: string | null }[]
): boolean {
  const live = lines.filter((l) => !l.deleted_at);
  if (live.length === 0) return false;
  return live.every((l) => l.line_status !== null && l.line_status !== "proposed");
}

/** Shared task-line rendering for both the grouped-request email body and the admin detail view — "{title} — {start}" or "{title} — {start} to {end}" when the range spans more than one day. Deliberately plain text (no HTML) so callers building an HTML table row or a plain admin list can both use it without stripping markup back out. */
export function formatTaskLineDateRange(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate} → ${endDate}`;
}

/**
 * Builds the email-safe HTML table ROWS (no surrounding <table>) for
 * the grouped-request email's task list — merged into
 * emails/trade-booking-request.html's {{task_rows}} placeholder by
 * lib/visit-emails.ts's merge(). Deliberately built here (not inline
 * at the call site) so the admin detail view (a plain React list, not
 * this exact markup) and the email can both start from the same
 * `formatTaskLineDateRange` without the HTML/plain-text split
 * duplicating the date-range logic twice.
 */
export function buildTaskRowsHtml(lines: { task_title: string; start_date: string; end_date: string }[]): string {
  return lines
    .map(
      (l) =>
        `<tr><td style="padding:10px 0; border-bottom:1px solid #e6dfcf; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight:400; font-size:14px; color:#1A1A1A;">${escapeHtml(l.task_title)}</td><td align="right" style="padding:10px 0; border-bottom:1px solid #e6dfcf; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight:300; font-size:13px; color:#313131;">${escapeHtml(formatTaskLineDateRange(l.start_date, l.end_date))}</td></tr>`
    )
    .join("");
}

/** Minimal HTML-escape for the free-text values (task titles) interpolated into buildTaskRowsHtml above — task titles are staff-authored board_tasks.title, not user-untrusted input from the public internet, but escaping costs nothing and this email is the one place this round writes free text directly into HTML rather than through a `{{placeholder}}` merge that a template author controls. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Given a line's OLD start_date and its trade-suggested start_date,
 * the whole-day delta to hand to the EXISTING POST
 * /api/phases/[id]/shift-items route (delta_days, positive = later) —
 * this round never reimplements that route's own ripple math, it only
 * ever computes the single number that route's body shape expects.
 */
export function computeShiftDeltaDays(oldStartDate: string, newStartDate: string): number {
  return diffDays(oldStartDate, newStartDate);
}
