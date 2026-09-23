import type { FinanceContributionInput } from "../../types/finance";
import type { FfeForecastTiming } from "./ffe-timing";

interface SnapshotLine {
  id: string;
  description?: string | null;
  qty?: number | null;
  rate_ex_gst?: number | null;
  cost_ex_gst?: number | null;
  gst_treatment?: "exclusive" | "inclusive" | "gst_free" | "not_applicable";
  source_currency?: string | null;
  source_forecast_total_minor?: number | null;
  forecast_fx_rate?: number | null;
  source_payments?: Array<{
    source_amount_minor?: number | null;
    settled_aud_minor?: number | null;
    paid_on?: string | null;
  }>;
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

interface SnapshotFfeItem {
  id: string;
  item_code?: string | null;
  name?: string | null;
  category: string;
  quantity?: number | null;
  cost_scope?: "direct" | "trade_package";
  unit_price_ex_gst?: number | null;
  total_ex_gst?: number | null;
  cost_net_minor?: number | null;
  cash_gross_minor?: number | null;
  pricing_confidence?: "quoted" | "placeholder" | "unpriced";
}

export interface FinanceEstimateSnapshot {
  sections: SnapshotSection[];
  ffe?: { categories?: SnapshotFfeCategory[] };
  ffe_items?: SnapshotFfeItem[];
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

/** Estimate snapshots are stored ex GST; a cash forecast must use bank cash. */
function exGstDollarsToGrossMinor(value: number): number {
  return dollarsToMinor(value * 1.1);
}

function estimateCashMinor(line: SnapshotLine): {
  plannedMinor: number;
  netMinor: number;
  taxMinor: number;
  sourceTotalMinor: number | null;
  sourcePaidMinor: number;
} {
  const treatment = line.gst_treatment ?? "exclusive";
  const netMinor = dollarsToMinor(lineCost(line));
  const sourceTotalMinor = Number.isSafeInteger(line.source_forecast_total_minor)
    ? Math.max(Number(line.source_forecast_total_minor), 0)
    : null;
  const fx = finiteNumber(line.forecast_fx_rate);
  const sourcePaidMinor = (line.source_payments ?? []).reduce((sum, payment) => {
    const amount = Number(payment.source_amount_minor);
    return Number.isSafeInteger(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
  const hasForeignForecast = Boolean(line.source_currency) && sourceTotalMinor !== null && fx > 0;
  const baseCashMinor = hasForeignForecast
    ? Math.round(Math.max(sourceTotalMinor - sourcePaidMinor, 0) * fx)
    : netMinor;
  if (!Number.isSafeInteger(baseCashMinor)) {
    throw new Error("Forecast source-currency amount exceeds safe minor units");
  }
  const plannedMinor = treatment === "exclusive"
    ? Math.round(baseCashMinor * 1.1)
    : baseCashMinor;
  return {
    plannedMinor,
    netMinor,
    taxMinor: plannedMinor - baseCashMinor,
    sourceTotalMinor,
    sourcePaidMinor,
  };
}

function frozenMinor(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Frozen estimate amount must use non-negative safe minor units");
  }
  return value;
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
  sectionDates?: Record<string, string>;
  itemTimings?: Record<string, FfeForecastTiming>;
  timingOverrides?: Record<string, string>;
}): FinanceContributionInput[] {
  const contributions: FinanceContributionInput[] = [];
  const knownKeys = new Set<string>();
  const knownOverrideKeys = new Set<string>();
  const sectionDates = input.sectionDates ?? {};
  const itemTimings = input.itemTimings ?? {};
  const overrides = input.timingOverrides ?? {};

  function add(contribution: FinanceContributionInput): void {
    if (knownKeys.has(contribution.contributionKey)) {
      throw new Error(`Duplicate estimate contribution: ${contribution.contributionKey}`);
    }
    knownKeys.add(contribution.contributionKey);
    knownOverrideKeys.add(contribution.contributionKey);
    contributions.push(contribution);
  }

  for (const section of input.snapshot.sections ?? []) {
    for (const line of section.lines ?? []) {
      const cash = estimateCashMinor(line);
      const { plannedMinor, netMinor } = cash;
      if (plannedMinor <= 0) continue;
      const contributionKey = `project:${input.projectId}|cost_line:${line.id}|scope:base`;
      const override = overrides[contributionKey] ?? null;
      const scheduleDate = sectionDates[section.id] ?? null;
      const plannedDate = override ?? scheduleDate;
      add({
        contributionKey,
        direction: "outflow",
        description: line.description?.trim() || "Estimate cost line",
        plannedMinor,
        plannedDate,
        baseEligible: true,
        confidence: plannedDate ? "medium" : "unknown",
        sourceTrace: {
          source_type: "estimate_cost_line",
          source_record_id: line.id,
          source_version_id: input.estimateVersionId,
          cash_basis: line.gst_treatment === "exclusive" || line.gst_treatment === undefined
            ? "gross_inc_gst"
            : "configured_tax_treatment",
          net_minor: netMinor,
          tax_minor: cash.taxMinor,
          gst_treatment: line.gst_treatment ?? "exclusive",
          source_currency: line.source_currency ?? null,
          source_forecast_total_minor: cash.sourceTotalMinor,
          source_paid_minor: cash.sourcePaidMinor,
          forecast_fx_rate: line.forecast_fx_rate ?? null,
          section_id: section.id,
          section_name: section.name,
          timing_source: override
            ? "shadow_override"
            : scheduleDate
              ? "construction_schedule"
              : "unmapped",
        },
      });
    }
  }

  const itemSnapshots = (input.snapshot.ffe_items ?? []).filter(
    (item) => item.cost_scope !== "trade_package"
  );
  if (itemSnapshots.length > 0) {
    for (const item of itemSnapshots) {
      const netDollars = item.total_ex_gst ??
        finiteNumber(item.quantity) * finiteNumber(item.unit_price_ex_gst);
      const netMinor = frozenMinor(
        item.cost_net_minor,
        dollarsToMinor(finiteNumber(netDollars))
      );
      const plannedMinor = frozenMinor(
        item.cash_gross_minor,
        exGstDollarsToGrossMinor(finiteNumber(netDollars))
      );
      if (plannedMinor <= 0) continue;

      const contributionKey = `project:${input.projectId}|ffe_item:${item.id}|scope:base`;
      const categoryOverrideKey = `project:${input.projectId}|ffe_category:${item.category}|scope:base`;
      const override = overrides[contributionKey] ?? overrides[categoryOverrideKey] ?? null;
      if (overrides[categoryOverrideKey]) knownOverrideKeys.add(categoryOverrideKey);
      const timing = itemTimings[item.id];
      const plannedDate = override ?? timing?.plannedDate ?? null;
      const weakPricing = item.pricing_confidence === "placeholder";
      add({
        contributionKey,
        direction: "outflow",
        description: item.name?.trim() || item.item_code?.trim() || `FF&E - ${item.category}`,
        plannedMinor,
        plannedDate,
        baseEligible: true,
        confidence: weakPricing
          ? "low"
          : override
            ? "medium"
            : timing?.confidence ?? "unknown",
        sourceTrace: {
          source_type: "estimate_ffe_item",
          source_record_id: item.id,
          source_version_id: input.estimateVersionId,
          cash_basis: "gross_inc_gst",
          net_minor: netMinor,
          tax_minor: plannedMinor - netMinor,
          item_id: item.id,
          item_code: item.item_code ?? null,
          category: item.category,
          quantity: finiteNumber(item.quantity),
          pricing_confidence: item.pricing_confidence ?? "unknown",
          timing_source: override
            ? "shadow_override"
            : timing?.timingSource ?? "unmapped",
          order_by_status: timing?.orderByStatus ?? null,
          works_date: timing?.worksDate ?? null,
          trade_name: timing?.tradeName ?? null,
          works_source_id: timing?.sourceId ?? null,
          works_source_kind: timing?.sourceKind ?? null,
        },
      });
    }
  } else {
    // Saved versions created before item snapshots remain valid and honest at
    // their original category granularity.
    for (const category of input.snapshot.ffe?.categories ?? []) {
      const netMinor = dollarsToMinor(finiteNumber(category.total));
      const plannedMinor = exGstDollarsToGrossMinor(finiteNumber(category.total));
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
          cash_basis: "gross_inc_gst",
          net_minor: netMinor,
          tax_minor: plannedMinor - netMinor,
          category: category.category,
          timing_source: override ? "shadow_override" : "unmapped",
        },
      });
    }
  }

  const variationNetMinor = dollarsToMinor(
    finiteNumber(input.snapshot.rollup?.approvedVariationsExGst)
  );
  const variationMinor = exGstDollarsToGrossMinor(
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
        cash_basis: "gross_inc_gst",
        net_minor: variationNetMinor,
        tax_minor: variationMinor - variationNetMinor,
        timing_source: override ? "shadow_override" : "unmapped",
      },
    });
  }

  const unknownOverrides = Object.keys(overrides).filter(
    (key) => !knownOverrideKeys.has(key)
  );
  if (unknownOverrides.length > 0) {
    throw new Error(`Unknown timing override contribution: ${unknownOverrides[0]}`);
  }

  return contributions;
}
