import type { FinanceContributionInput } from "../../types/finance";

interface SnapshotLine {
  id: string;
  description?: string | null;
  qty?: number | null;
  rate_ex_gst?: number | null;
  cost_ex_gst?: number | null;
}

interface SnapshotSection {
  id: string;
  name: string;
  lines: SnapshotLine[];
}

interface SnapshotFfeCategory {
  category: string;
  total: number;
  placeholder_count?: number;
  unpriced_count?: number;
}

export interface FinanceEstimateSnapshot {
  sections: SnapshotSection[];
  ffe?: { categories?: SnapshotFfeCategory[] };
  rollup?: { approvedVariationsExGst?: number };
}

function finiteNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function dollarsToMinor(value: number): number {
  const minor = Math.round((value + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error("Estimate amount exceeds safe minor units");
  return minor;
}

function lineCost(line: SnapshotLine): number {
  const calculated = finiteNumber(line.qty) * finiteNumber(line.rate_ex_gst);
  const explicit = line.cost_ex_gst;
  if (explicit !== null && explicit !== undefined) {
    const numeric = finiteNumber(explicit);
    if (numeric !== 0 || calculated === 0) return numeric;
  }
  return calculated;
}

export function buildEstimatePlanContributions(input: {
  projectId: string;
  estimateVersionId: string;
  snapshot: FinanceEstimateSnapshot;
  timingOverrides?: Record<string, string>;
}): FinanceContributionInput[] {
  const contributions: FinanceContributionInput[] = [];
  const knownKeys = new Set<string>();
  const overrides = input.timingOverrides ?? {};

  function add(contribution: FinanceContributionInput): void {
    if (knownKeys.has(contribution.contributionKey)) {
      throw new Error(`Duplicate estimate contribution: ${contribution.contributionKey}`);
    }
    knownKeys.add(contribution.contributionKey);
    contributions.push(contribution);
  }

  for (const section of input.snapshot.sections ?? []) {
    for (const line of section.lines ?? []) {
      const plannedMinor = dollarsToMinor(lineCost(line));
      if (plannedMinor <= 0) continue;
      const contributionKey = `project:${input.projectId}|cost_line:${line.id}|scope:base`;
      const override = overrides[contributionKey] ?? null;
      add({
        contributionKey,
        direction: "outflow",
        description: line.description?.trim() || "Estimate cost line",
        plannedMinor,
        plannedDate: override,
        baseEligible: true,
        confidence: override ? "medium" : "unknown",
        sourceTrace: {
          source_type: "estimate_cost_line",
          source_record_id: line.id,
          source_version_id: input.estimateVersionId,
          section_id: section.id,
          section_name: section.name,
          timing_source: override ? "shadow_override" : "unmapped",
        },
      });
    }
  }

  for (const category of input.snapshot.ffe?.categories ?? []) {
    const plannedMinor = dollarsToMinor(finiteNumber(category.total));
    if (plannedMinor <= 0) continue;
    const contributionKey = `project:${input.projectId}|ffe_category:${category.category}|scope:base`;
    const override = overrides[contributionKey] ?? null;
    const hasWeakPricing =
      finiteNumber(category.placeholder_count) > 0 || finiteNumber(category.unpriced_count) > 0;
    add({
      contributionKey,
      direction: "outflow",
      description: `FF&E - ${category.category || "Uncategorised"}`,
      plannedMinor,
      plannedDate: override,
      baseEligible: true,
      confidence: override ? (hasWeakPricing ? "low" : "medium") : "unknown",
      sourceTrace: {
        source_type: "estimate_ffe_category",
        source_version_id: input.estimateVersionId,
        category: category.category,
        timing_source: override ? "shadow_override" : "unmapped",
      },
    });
  }

  const variationMinor = dollarsToMinor(
    finiteNumber(input.snapshot.rollup?.approvedVariationsExGst)
  );
  if (variationMinor > 0) {
    const contributionKey = `project:${input.projectId}|approved_variations|scope:base`;
    const override = overrides[contributionKey] ?? null;
    add({
      contributionKey,
      direction: "outflow",
      description: "Approved variations",
      plannedMinor: variationMinor,
      plannedDate: override,
      baseEligible: true,
      confidence: override ? "medium" : "unknown",
      sourceTrace: {
        source_type: "estimate_approved_variations",
        source_version_id: input.estimateVersionId,
        timing_source: override ? "shadow_override" : "unmapped",
      },
    });
  }

  const unknownOverrides = Object.keys(overrides).filter((key) => !knownKeys.has(key));
  if (unknownOverrides.length > 0) {
    throw new Error(`Unknown timing override contribution: ${unknownOverrides[0]}`);
  }

  return contributions;
}
