import type {
  FinanceContributionInput,
  FinanceRecurringCommitment,
  FinanceRecurringFrequency,
} from "../../types/finance";
import { buildWeeklyPeriods } from "./projection.ts";

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

function escalatedAmount(commitment: FinanceRecurringCommitment, dueDate: string): number {
  const multiplier = 1 + commitment.annual_escalation_bps / 10_000;
  const amount = Math.round(
    commitment.amount_minor * multiplier ** yearsSince(commitment.first_due_date, dueDate)
  );
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${commitment.id}.amount_minor is outside safe minor-unit range`);
  }
  return amount;
}

export function generateRecurringContributions(input: {
  commitments: FinanceRecurringCommitment[];
  asOfDate: string;
  weeklyPeriods?: number;
}): FinanceContributionInput[] {
  const periods = buildWeeklyPeriods(input.asOfDate, input.weeklyPeriods ?? 13);
  const horizonEnd = periods.at(-1)!.endsOn;
  const contributions: FinanceContributionInput[] = [];

  for (const commitment of input.commitments) {
    if (commitment.status !== "active") continue;
    for (let index = 0; index < 10_000; index += 1) {
      if (commitment.frequency === "once" && index > 0) break;
      const dueDate = occurrenceDate(commitment.first_due_date, commitment.frequency, index);
      if (commitment.end_date && dueDate > commitment.end_date) break;
      if (dueDate > horizonEnd) break;
      if (dueDate < input.asOfDate) continue;

      contributions.push({
        contributionKey: `recurring:${commitment.id}:${dueDate}`,
        direction: "outflow",
        description: commitment.name,
        plannedMinor: escalatedAmount(commitment, dueDate),
        plannedDate: dueDate,
        baseEligible: true,
        confidence: commitment.confidence,
        sourceTrace: {
          source: "recurring_commitment",
          recurring_commitment_id: commitment.id,
          category: commitment.category,
          supplier_or_payee: commitment.supplier_or_payee,
          frequency: commitment.frequency,
          due_date: dueDate,
        },
      });
    }
  }

  return contributions.sort((a, b) =>
    String(a.plannedDate).localeCompare(String(b.plannedDate)) ||
    a.contributionKey.localeCompare(b.contributionKey)
  );
}
