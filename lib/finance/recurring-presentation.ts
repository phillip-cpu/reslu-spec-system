import type { FinanceRecurringCommitment } from "../../types/finance";

/** End dates are inclusive, matching recurrence generation's calendar-date cutoff. */
export function hasRecurringCommitmentEnded(
  commitment: Pick<FinanceRecurringCommitment, "end_date">,
  asOfDate: string
): boolean {
  return commitment.end_date !== null && commitment.end_date < asOfDate;
}

/** Presentation only: keep ended schedules active in storage to preserve unpaid history. */
export function isCurrentActiveRecurringCommitment(
  commitment: Pick<FinanceRecurringCommitment, "status" | "end_date">,
  asOfDate: string
): boolean {
  return commitment.status === "active" && !hasRecurringCommitmentEnded(commitment, asOfDate);
}
