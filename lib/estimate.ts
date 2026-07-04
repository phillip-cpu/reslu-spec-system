// ============================================================
// RESLU Spec System — Estimating module rollup math
// Shared, pure functions used by both the estimate API routes
// (app/api/projects/[id]/estimate/**, app/api/estimate/**) and the UI
// (components/estimate/**) so the numbers can never drift between
// server and client. Deliberately dependency-free and unit-testable
// (no Supabase/Next imports here).
//
// BUILD-SPEC.md "Estimating module — enriched from Phillip's Excel
// template": "Summary layer: subtotal per section, all-trades
// subtotal, markup % → markup $, total to client ex GST, GST 10%,
// total inc GST — replicating the Excel's summary block exactly."
// ============================================================

import type { CostLine, Variation } from "@/types";

/** GST rate, fixed at 10% per BUILD-SPEC.md ("GST 10%" everywhere it's mentioned). */
export const GST_RATE = 0.1;

// ------------------------------------------------------------
// Money rounding
//
// Choice: round-half-up to 2 decimal places, applied at each display
// boundary (i.e. when a computed money value is about to be shown or
// persisted as a final total) rather than after every intermediate
// arithmetic step. Intermediate sums (e.g. summing many line costs)
// are kept as full-precision JS numbers and only rounded once, at the
// point the rollup value is finalised — this avoids compounding
// rounding error across dozens of lines/sections, which is the
// classic Excel-vs-hand-calc mismatch this module is explicitly
// trying to eliminate ("the Excel killer").
//
// Cents-safe: multiplying by 100, using Math.round (which rounds
// half away from zero for positive numbers — equivalent to "round
// half up" for all values used in this module, which are never
// negative amounts... except `variance`, which CAN be negative. For
// negative numbers Math.round rounds half *toward* zero on some
// engines historically, but per the ECMAScript spec Math.round always
// rounds a X.5 toward +Infinity, which for negative halves is "round
// half up" in the literal numeric-line sense (e.g. -2.5 -> -2). That
// is the documented, spec-guaranteed behaviour relied on here.
// ------------------------------------------------------------
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ------------------------------------------------------------
// Line-level math
// ------------------------------------------------------------

/** Minimal shape needed for lineCost/variance — a subset of CostLine. */
export interface LineCostInput {
  qty: number | null;
  rate_ex_gst: number | null;
  cost_ex_gst: number | null;
}

/**
 * lineCost(line) = cost_ex_gst if manually set (override), else
 * qty * rate_ex_gst if both present, else null (unknown/not yet costed).
 * BUILD-SPEC.md: "cost_ex_gst numeric(12,2) nullable (manual override;
 * else computed qty*rate in app)".
 */
export function lineCost(line: LineCostInput): number | null {
  if (line.cost_ex_gst !== null && line.cost_ex_gst !== undefined) {
    return roundMoney(line.cost_ex_gst);
  }
  if (
    line.qty !== null &&
    line.qty !== undefined &&
    line.rate_ex_gst !== null &&
    line.rate_ex_gst !== undefined
  ) {
    return roundMoney(line.qty * line.rate_ex_gst);
  }
  return null;
}

/**
 * variance = quoted_to_client_ex_gst − actual_paid_ex_gst, only when
 * BOTH are present (BUILD-SPEC.md: "variance (computed: quoted −
 * actual)"). Null when either side is unknown — a null variance means
 * "not yet comparable", not zero, so the UI must not render it as $0.
 * Negative variance (actual > quoted) is the "over budget" case the
 * UI highlights in red.
 */
export function lineVariance(line: {
  quoted_to_client_ex_gst: number | null;
  actual_paid_ex_gst: number | null;
}): number | null {
  if (
    line.quoted_to_client_ex_gst === null ||
    line.quoted_to_client_ex_gst === undefined ||
    line.actual_paid_ex_gst === null ||
    line.actual_paid_ex_gst === undefined
  ) {
    return null;
  }
  return roundMoney(line.quoted_to_client_ex_gst - line.actual_paid_ex_gst);
}

// ------------------------------------------------------------
// Section-level rollup
// ------------------------------------------------------------

export interface SectionRollup {
  costExGst: number;
  quotedExGst: number;
  actualExGst: number;
  /** Sum of per-line variance across lines where variance is computable; null if none are. */
  variance: number | null;
}

/** Sums cost/quoted/actual across a section's (already-filtered, non-deleted) lines. */
export function sectionRollup(lines: LineForRollup[]): SectionRollup {
  let costExGst = 0;
  let quotedExGst = 0;
  let actualExGst = 0;
  let variance = 0;
  let hasVariance = false;

  for (const line of lines) {
    const cost = lineCost(line);
    if (cost !== null) costExGst += cost;
    if (line.quoted_to_client_ex_gst !== null && line.quoted_to_client_ex_gst !== undefined) {
      quotedExGst += line.quoted_to_client_ex_gst;
    }
    if (line.actual_paid_ex_gst !== null && line.actual_paid_ex_gst !== undefined) {
      actualExGst += line.actual_paid_ex_gst;
    }
    const lv = lineVariance(line);
    if (lv !== null) {
      variance += lv;
      hasVariance = true;
    }
  }

  return {
    costExGst: roundMoney(costExGst),
    quotedExGst: roundMoney(quotedExGst),
    actualExGst: roundMoney(actualExGst),
    variance: hasVariance ? roundMoney(variance) : null,
  };
}

/** Shape sectionRollup/projectRollup need from a cost line. */
export type LineForRollup = LineCostInput & {
  quoted_to_client_ex_gst: number | null;
  actual_paid_ex_gst: number | null;
};

// ------------------------------------------------------------
// Variations rollup
// ------------------------------------------------------------

/**
 * Total of APPROVED variations only, ex GST — this is the figure that
 * "feeds the Contingency section's 'Approved variations' line" per
 * BUILD-SPEC.md. Proposed/rejected variations do not affect the
 * project total.
 */
export function approvedVariationsTotal(
  variations: Pick<Variation, "status" | "cost_ex_gst">[]
): number {
  const total = variations
    .filter((v) => v.status === "approved")
    .reduce((sum, v) => sum + (v.cost_ex_gst ?? 0), 0);
  return roundMoney(total);
}

// ------------------------------------------------------------
// Project-level rollup — the sticky summary block
// ------------------------------------------------------------

export interface ProjectRollupInput {
  /** Every non-deleted cost line across all of the project's sections. */
  lines: LineForRollup[];
  /** Every non-deleted variation for the project. */
  variations: Pick<Variation, "status" | "cost_ex_gst">[];
  /** projects.estimate_markup_pct — a fraction, e.g. 0.15 for 15%. */
  markupPct: number;
}

export interface ProjectRollup {
  /** Sum of all cost lines' computed cost, ex GST — "All Trades subtotal". */
  allTradesSubtotalExGst: number;
  /** Sum of approved variations, ex GST — folded into the total per BUILD-SPEC.md. */
  approvedVariationsExGst: number;
  /** markupPct as supplied (fraction). */
  markupPct: number;
  /** Markup $ = (allTradesSubtotal + approvedVariations) * markupPct. */
  markupExGst: number;
  /** Total to client ex GST = all-trades subtotal + approved variations + markup. */
  totalToClientExGst: number;
  /** GST at 10% of totalToClientExGst. */
  gst: number;
  /** Total inc GST — the headline figure. */
  totalIncGst: number;
  /** Sum of quoted_to_client_ex_gst across all lines (informational). */
  quotedExGst: number;
  /** Sum of actual_paid_ex_gst across all lines (informational). */
  actualExGst: number;
}

/**
 * Whole-estimate rollup replicating the Excel's summary block:
 * All Trades subtotal → markup % → markup $ → Total to Client ex GST
 * → GST → Total inc GST, with approved variations folded in before
 * markup is applied (variations are additional scope, so they're
 * marked up the same as any other trade cost — consistent with the
 * Contingency section's "Approved variations" line being just another
 * cost line in the same rollup).
 */
export function projectRollup({
  lines,
  variations,
  markupPct,
}: ProjectRollupInput): ProjectRollup {
  const { costExGst: allTradesSubtotalExGst, quotedExGst, actualExGst } =
    sectionRollup(lines);
  const approvedVariationsExGst = approvedVariationsTotal(variations);

  const preMarkupBase = allTradesSubtotalExGst + approvedVariationsExGst;
  const markupExGst = roundMoney(preMarkupBase * markupPct);
  const totalToClientExGst = roundMoney(preMarkupBase + markupExGst);
  const gst = roundMoney(totalToClientExGst * GST_RATE);
  const totalIncGst = roundMoney(totalToClientExGst + gst);

  return {
    allTradesSubtotalExGst: roundMoney(allTradesSubtotalExGst),
    approvedVariationsExGst,
    markupPct,
    markupExGst,
    totalToClientExGst,
    gst,
    totalIncGst,
    quotedExGst: roundMoney(quotedExGst),
    actualExGst: roundMoney(actualExGst),
  };
}

// ------------------------------------------------------------
// Measurements rollup
// ------------------------------------------------------------

/** Sum of measurement values within a single group (same unit assumed — Phase 1.5 doesn't do unit conversion). */
export function measurementGroupTotal(values: number[]): number {
  return roundMoney(values.reduce((sum, v) => sum + v, 0));
}

// ------------------------------------------------------------
// Variation inc-GST helper (Variations register column)
// ------------------------------------------------------------

/** Computed "cost inc GST" for a single variation row in the register table. */
export function variationIncGst(costExGst: number | null): number | null {
  if (costExGst === null || costExGst === undefined) return null;
  return roundMoney(costExGst * (1 + GST_RATE));
}

// Re-exported for callers that want the CostLine type directly rather
// than the minimal LineForRollup shape (e.g. mapping straight from a
// Supabase row).
export type { CostLine };
