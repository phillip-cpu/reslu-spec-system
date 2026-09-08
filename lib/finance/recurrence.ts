import type {
  FinanceContributionInput,
  FinanceRecurringCommitment,
  FinanceRecurringFrequency,
} from "../../types/finance";
import { buildWeeklyPeriods } from "./projection.ts";
import { isIsoDate } from "./readiness.ts";

export interface FinanceRecurringPaymentEntry {
  amount_minor: number;
  paid_on: string;
}

/** Cumulative settlement plus its individual cash dates; never infer this from a due date. */
export interface FinanceRecurringOccurrencePayment {
  commitment_id: string;
  due_date: string;
  scheduled_amount_minor: number;
  amount_paid_minor: number;
  paid_on: string | null;
  payment_entries: FinanceRecurringPaymentEntry[];
  version: number;
}

export interface FinanceRecurringOccurrence {
  commitment_id: string;
  name: string;
  due_date: string;
  amount_minor: number;
  paid_minor: number;
  remaining_minor: number;
  payment_version: number;
  paid_on: string | null;
  payment_entries: FinanceRecurringPaymentEntry[];
  status: "unpaid" | "part_paid" | "paid";
}

const DAY_MS = 86_400_000;

function dateAtUtc(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function plainDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function occurrenceDate(
  firstDueDate: string,
  frequency: FinanceRecurringFrequency,
  index: number
): string {
  if (frequency === "once") return firstDueDate;

  const first = dateAtUtc(firstDueDate);
  if (frequency === "weekly" || frequency === "fortnightly") {
    const interval = frequency === "weekly" ? 7 : 14;
    return plainDate(new Date(first.valueOf() + index * interval * DAY_MS));
  }

  const monthStep = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const absoluteMonth = first.getUTCFullYear() * 12 + first.getUTCMonth() + index * monthStep;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth % 12;
  const day = Math.min(first.getUTCDate(), daysInMonth(year, month));
  return plainDate(new Date(Date.UTC(year, month, day)));
}

export function isRecurringOccurrenceDate(
  commitment: FinanceRecurringCommitment,
  dueDate: string
): boolean {
  if (!isIsoDate(dueDate) || dueDate < commitment.first_due_date ||
      (commitment.end_date && dueDate > commitment.end_date)) return false;
  for (let index = 0; index < 10_000; index += 1) {
    const date = occurrenceDate(commitment.first_due_date, commitment.frequency, index);
    if (date === dueDate) return true;
    if (date > dueDate || commitment.frequency === "once") return false;
  }
  return false;
}

function yearsSince(firstDueDate: string, dueDate: string): number {
  const first = dateAtUtc(firstDueDate);
  const due = dateAtUtc(dueDate);
  let years = due.getUTCFullYear() - first.getUTCFullYear();
  if (
    due.getUTCMonth() < first.getUTCMonth() ||
    (due.getUTCMonth() === first.getUTCMonth() && due.getUTCDate() < first.getUTCDate())
  ) {
    years -= 1;
  }
  return Math.max(years, 0);
}

export function recurringOccurrenceAmount(commitment: FinanceRecurringCommitment, dueDate: string): number {
  const multiplier = 1 + commitment.annual_escalation_bps / 10_000;
  const amount = Math.round(
    commitment.amount_minor * multiplier ** yearsSince(commitment.first_due_date, dueDate)
  );
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${commitment.id}.amount_minor is outside safe minor-unit range`);
  }
  return amount;
}

type RecurrenceInput = {
  commitments: FinanceRecurringCommitment[];
  payments?: FinanceRecurringOccurrencePayment[];
  asOfDate: string;
  weeklyPeriods?: number;
};

export function normalizeRecurringPayment(row: Record<string, unknown>): FinanceRecurringOccurrencePayment {
  const amount = Number(row.amount_paid_minor);
  const scheduled = Number(row.scheduled_amount_minor);
  const entries = row.payment_entries as FinanceRecurringPaymentEntry[];
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(scheduled) || scheduled <= 0 ||
      scheduled < amount || !Array.isArray(entries) ||
      (amount === 0 ? row.paid_on !== null : !isIsoDate(row.paid_on)) ||
      entries.some((entry) => !Number.isSafeInteger(entry.amount_minor) || entry.amount_minor <= 0 || !isIsoDate(entry.paid_on)) ||
      entries.reduce((sum, entry) => sum + entry.amount_minor, 0) !== amount) {
    throw new Error("Recurring payment amounts or payment history are invalid");
  }
  return { ...row, amount_paid_minor: amount, scheduled_amount_minor: scheduled } as unknown as FinanceRecurringOccurrencePayment;
}

export function generateRecurringOccurrences(input: RecurrenceInput): FinanceRecurringOccurrence[] {
  const periods = buildWeeklyPeriods(input.asOfDate, input.weeklyPeriods ?? 13);
  const horizonEnd = periods.at(-1)!.endsOn;
  const payments = new Map((input.payments ?? []).map((item) => [
    `${item.commitment_id}:${item.due_date}`, item,
  ]));
  const occurrences = new Map<string, FinanceRecurringOccurrence>();
  function add(commitment: FinanceRecurringCommitment, dueDate: string) {
    const key = `${commitment.id}:${dueDate}`;
    const payment = payments.get(key);
    const entries = (payment?.payment_entries ?? []).filter((entry) => entry.paid_on <= input.asOfDate);
    const amount = payment?.scheduled_amount_minor ?? recurringOccurrenceAmount(commitment, dueDate);
    const paid = entries.reduce((sum, entry) => sum + entry.amount_minor, 0);
    if (paid > amount) throw new Error(`Recurring occurrence ${key} is overpaid`);
    occurrences.set(key, {
      commitment_id: commitment.id, name: commitment.name, due_date: dueDate,
      amount_minor: amount, paid_minor: paid, remaining_minor: amount - paid,
      payment_version: payment?.version ?? 0,
      paid_on: entries.map((entry) => entry.paid_on).sort().at(-1) ?? null,
      payment_entries: entries,
      status: paid === amount ? "paid" : paid > 0 ? "part_paid" : "unpaid",
    });
  }
  for (const commitment of input.commitments) {
    if (commitment.status === "active") {
      // Migration starts explicit tracking prospectively; do not invent old debts/payments.
      const trackedFrom = commitment.tracking_started_on && commitment.tracking_started_on <= input.asOfDate
        ? commitment.tracking_started_on : input.asOfDate;
      for (let index = 0; index < 10_000; index += 1) {
        if (commitment.frequency === "once" && index > 0) break;
        const dueDate = occurrenceDate(commitment.first_due_date, commitment.frequency, index);
        if (commitment.end_date && dueDate > commitment.end_date) break;
        if (dueDate > horizonEnd) break;
        if (dueDate < trackedFrom) continue;
        add(commitment, dueDate);
      }
    }
    // Explicit payment history survives pausing, archiving, schedule edits and cutoff changes.
    for (const payment of input.payments ?? []) {
      if (payment.commitment_id !== commitment.id) continue;
      if (payment.due_date <= horizonEnd || payment.payment_entries.some((entry) => entry.paid_on <= input.asOfDate)) {
        add(commitment, payment.due_date);
      }
    }
  }
  return [...occurrences.values()].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.commitment_id.localeCompare(b.commitment_id));
}

export function generateRecurringContributions(input: RecurrenceInput): FinanceContributionInput[] {
  const horizonEnd = buildWeeklyPeriods(input.asOfDate, input.weeklyPeriods ?? 13).at(-1)!.endsOn;
  const commitments = new Map(input.commitments.map((item) => [item.id, item]));
  const contributions: FinanceContributionInput[] = [];
  for (const occurrence of generateRecurringOccurrences(input)) {
    const commitment = commitments.get(occurrence.commitment_id)!;
    const key = `recurring:${commitment.id}:${occurrence.due_date}`;
    const common = {
      direction: "outflow" as const, description: commitment.name,
      baseEligible: true, confidence: commitment.confidence,
      sourceTrace: {
        source: "recurring_commitment", recurring_commitment_id: commitment.id,
        category: commitment.category, supplier_or_payee: commitment.supplier_or_payee,
        frequency: commitment.frequency, due_date: occurrence.due_date,
        occurrence_amount_minor: occurrence.amount_minor,
        occurrence_paid_minor: occurrence.paid_minor,
        payment_version: occurrence.payment_version,
      },
    };
    if (occurrence.remaining_minor > 0 && occurrence.due_date <= horizonEnd) {
      contributions.push({ ...common, contributionKey: key,
        plannedMinor: occurrence.remaining_minor, plannedDate: occurrence.due_date });
    }
    occurrence.payment_entries.forEach((entry, index) => {
      contributions.push({ ...common, contributionKey: `${key}:paid:${index}`,
        plannedMinor: 0, plannedDate: occurrence.due_date,
        actualAccruedMinor: entry.amount_minor, actualPaidMinor: entry.amount_minor,
        actualPaidDate: entry.paid_on,
        sourceTrace: { ...common.sourceTrace, recurring_payment_entry_index: index,
          payment_source: "manual_recurring_payment", paid_on: entry.paid_on },
      });
    });
  }

  return contributions.sort((a, b) =>
    String(a.plannedDate).localeCompare(String(b.plannedDate)) ||
    a.contributionKey.localeCompare(b.contributionKey)
  );
}
