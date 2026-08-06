import type {
  EffectiveFinanceContribution,
  FinanceContributionInput,
  FinanceProjectionPeriod,
  FinanceShadowProjection,
} from "../../types/finance";

const DAY_MS = 86_400_000;

function assertPlainDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real ISO calendar date`);
  }
}

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function plainDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  return plainDate(new Date(toDate(value).valueOf() + days * DAY_MS));
}

function startOfMondayWeek(value: string): string {
  const date = toDate(value);
  const day = date.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return addDays(value, -daysSinceMonday);
}

function assertMinor(value: number, label: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(`${label} must be a ${allowNegative ? "safe" : "non-negative safe"} integer`);
  }
}

export function buildWeeklyPeriods(asOfDate: string, count = 13): Array<{
  startsOn: string;
  endsOn: string;
}> {
  assertPlainDate(asOfDate, "asOfDate");
  if (!Number.isInteger(count) || count <= 0 || count > 104) {
    throw new Error("weekly period count must be an integer from 1 to 104");
  }
  const firstStart = startOfMondayWeek(asOfDate);
  return Array.from({ length: count }, (_, index) => {
    const startsOn = addDays(firstStart, index * 7);
    return { startsOn, endsOn: addDays(startsOn, 6) };
  });
}

function effectiveTotal(input: FinanceContributionInput): number {
  const planned = input.plannedMinor;
  const committed = input.committedMinor ?? 0;
  const accrued = input.actualAccruedMinor ?? 0;
  return committed > 0 ? Math.max(committed, accrued) : Math.max(planned, accrued);
}

function validateContribution(input: FinanceContributionInput): void {
  if (!input.contributionKey.trim()) throw new Error("contributionKey is required");
  assertMinor(input.plannedMinor, `${input.contributionKey}.plannedMinor`);
  assertMinor(input.committedMinor ?? 0, `${input.contributionKey}.committedMinor`);
  assertMinor(
    input.actualAccruedMinor ?? 0,
    `${input.contributionKey}.actualAccruedMinor`
  );
  assertMinor(input.actualPaidMinor ?? 0, `${input.contributionKey}.actualPaidMinor`);
  if ((input.actualPaidMinor ?? 0) > (input.actualAccruedMinor ?? 0)) {
    throw new Error(`${input.contributionKey}.actualPaidMinor cannot exceed accrued actual`);
  }
  for (const [label, value] of [
    ["plannedDate", input.plannedDate],
    ["committedDate", input.committedDate],
    ["actualDueDate", input.actualDueDate],
    ["actualPaidDate", input.actualPaidDate],
  ] as const) {
    if (value) assertPlainDate(value, `${input.contributionKey}.${label}`);
  }
}

export function resolveEffectiveContributions(inputs: FinanceContributionInput[]): {
  contributions: EffectiveFinanceContribution[];
  excludedFromBaseMinor: number;
} {
  const contributions: EffectiveFinanceContribution[] = [];
  const seen = new Set<string>();
  let excludedFromBaseMinor = 0;

  for (const input of inputs) {
    validateContribution(input);
    if (seen.has(input.contributionKey)) {
      throw new Error(`Duplicate contribution key: ${input.contributionKey}`);
    }
    seen.add(input.contributionKey);

    if (input.baseEligible === false) {
      excludedFromBaseMinor += effectiveTotal(input);
      continue;
    }

    const committed = input.committedMinor ?? 0;
    const accrued = input.actualAccruedMinor ?? 0;
    const paid = input.actualPaidMinor ?? 0;
    const common = {
      contributionKey: input.contributionKey,
      direction: input.direction,
      description: input.description,
      confidence: input.confidence ?? "unknown",
      sourceTrace: input.sourceTrace ?? {},
    };

    if (paid > 0) {
      contributions.push({
        ...common,
        state: "actual_paid",
        amountMinor: paid,
        effectiveDate: input.actualPaidDate ?? null,
      });
    }

    const unpaidActual = accrued - paid;
    if (unpaidActual > 0) {
      contributions.push({
        ...common,
        state: "actual_accrued",
        amountMinor: unpaidActual,
        effectiveDate: input.actualDueDate ?? null,
      });
    }

    const remainingCommitment = Math.max(committed - accrued, 0);
    if (remainingCommitment > 0) {
      contributions.push({
        ...common,
        state: "committed",
        amountMinor: remainingCommitment,
        effectiveDate: input.committedDate ?? null,
      });
    }

    // A commitment on the same contribution key is a full-scope award:
    // it replaces the estimate even when it is cheaper. Without a
    // commitment, actuals progressively reduce the approved plan.
    const remainingPlan = committed > 0 ? 0 : Math.max(input.plannedMinor - accrued, 0);
    if (remainingPlan > 0) {
      contributions.push({
        ...common,
        state: "planned",
        amountMinor: remainingPlan,
        effectiveDate: input.plannedDate ?? null,
      });
    }
  }

  return { contributions, excludedFromBaseMinor };
}

export function calculateShadowProjection(input: {
  asOfDate: string;
  openingCashMinor: number;
  contributions: FinanceContributionInput[];
  weeklyPeriods?: number;
}): FinanceShadowProjection {
  assertPlainDate(input.asOfDate, "asOfDate");
  assertMinor(input.openingCashMinor, "openingCashMinor", true);
  const periodDates = buildWeeklyPeriods(input.asOfDate, input.weeklyPeriods ?? 13);
  const resolved = resolveEffectiveContributions(input.contributions);
  const firstStart = periodDates[0].startsOn;
  const lastEnd = periodDates[periodDates.length - 1].endsOn;
  let unknownTimingMinor = 0;
  let outsideHorizonMinor = 0;

  const periodContributions: EffectiveFinanceContribution[][] = periodDates.map(() => []);
  for (const contribution of resolved.contributions) {
    if (!contribution.effectiveDate) {
      unknownTimingMinor += contribution.amountMinor;
      continue;
    }

    let effectiveDate = contribution.effectiveDate;
    if (effectiveDate < firstStart) {
      // Historical paid cash is already represented in opening cash.
      if (contribution.state === "actual_paid") continue;
      // Overdue unpaid/forecast obligations are due in the first week.
      effectiveDate = firstStart;
    }
    if (effectiveDate > lastEnd) {
      outsideHorizonMinor += contribution.amountMinor;
      continue;
    }
    const index = periodDates.findIndex(
      (period) => effectiveDate >= period.startsOn && effectiveDate <= period.endsOn
    );
    if (index >= 0) periodContributions[index].push(contribution);
  }

  let runningCash = input.openingCashMinor;
  const periods: FinanceProjectionPeriod[] = periodDates.map((period, index) => {
    const contributions = periodContributions[index];
    const inflowMinor = contributions
      .filter((item) => item.direction === "inflow")
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const outflowMinor = contributions
      .filter((item) => item.direction === "outflow")
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const actualInflowMinor = contributions
      .filter((item) => item.direction === "inflow" && item.state === "actual_paid")
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const actualOutflowMinor = contributions
      .filter((item) => item.direction === "outflow" && item.state === "actual_paid")
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const openingCashMinor = runningCash;
    runningCash = openingCashMinor + inflowMinor - outflowMinor;
    return {
      periodKind: "week",
      periodIndex: index,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      openingCashMinor,
      inflowMinor,
      outflowMinor,
      actualInflowMinor,
      actualOutflowMinor,
      closingCashMinor: runningCash,
      contributions,
    };
  });

  let lowestCashMinor = input.openingCashMinor;
  let lowestCashPeriodIndex: number | null = null;
  for (const period of periods) {
    if (period.closingCashMinor < lowestCashMinor) {
      lowestCashMinor = period.closingCashMinor;
      lowestCashPeriodIndex = period.periodIndex;
    }
  }

  return {
    calculationVersion: "finance-shadow-v1",
    asOfDate: input.asOfDate,
    openingCashMinor: input.openingCashMinor,
    periods,
    effectiveContributions: resolved.contributions,
    unknownTimingMinor,
    outsideHorizonMinor,
    excludedFromBaseMinor: resolved.excludedFromBaseMinor,
    lowestCashMinor,
    lowestCashPeriodIndex,
    totalInflowMinor: periods.reduce((sum, period) => sum + period.inflowMinor, 0),
    totalOutflowMinor: periods.reduce((sum, period) => sum + period.outflowMinor, 0),
  };
}
