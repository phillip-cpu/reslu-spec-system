import type { FinanceContributionInput, FinanceShadowProjection } from "../../types/finance";

const ALLOWANCE_SOURCES = new Set([
  "estimate_cost_line",
  "estimate_ffe_category",
  "estimate_approved_variations",
]);

export function isEstimateAllowance(contribution: FinanceContributionInput): boolean {
  const sourceType = contribution.sourceTrace?.source_type;
  return typeof sourceType === "string" && ALLOWANCE_SOURCES.has(sourceType);
}

/**
 * Removes only the uncommitted estimate component. Supplier bills, awarded
 * commitments and paid actuals on the same scope remain cash facts.
 */
export function cashCommitmentContributions(
  contributions: FinanceContributionInput[]
): FinanceContributionInput[] {
  return contributions.map((contribution) =>
    isEstimateAllowance(contribution)
      ? { ...contribution, plannedMinor: 0 }
      : contribution
  );
}

export function estimateAllowanceSummary(projection: FinanceShadowProjection): {
  totalMinor: number;
  datedMinor: number;
  undatedMinor: number;
  overdueMinor: number;
  itemCount: number;
} {
  const firstWeekStart = projection.periods[0]?.startsOn ?? projection.asOfDate;
  const allowances = projection.effectiveContributions.filter(
    (contribution) =>
      contribution.direction === "outflow" &&
      contribution.state === "planned" &&
      typeof contribution.sourceTrace.source_type === "string" &&
      ALLOWANCE_SOURCES.has(contribution.sourceTrace.source_type)
  );
  const totalMinor = allowances.reduce((sum, item) => sum + item.amountMinor, 0);
  const undatedMinor = allowances
    .filter((item) => !item.effectiveDate)
    .reduce((sum, item) => sum + item.amountMinor, 0);
  const overdueMinor = allowances
    .filter((item) => item.effectiveDate !== null && item.effectiveDate < firstWeekStart)
    .reduce((sum, item) => sum + item.amountMinor, 0);
  return {
    totalMinor,
    datedMinor: totalMinor - undatedMinor,
    undatedMinor,
    overdueMinor,
    itemCount: allowances.length,
  };
}

