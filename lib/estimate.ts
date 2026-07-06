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

import type { CostLine, Measurement, Variation } from "@/types";

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
  /** Week 7 — Estimate ↔ Schedule integration, both optional so every
   * existing caller (unlinked lines, older call sites) is unaffected. */
  measurement_id?: string | null;
  wastage_pct?: number | null;
}

/**
 * Minimal shape needed from a measurement to compute effectiveQty —
 * a subset of Measurement.
 */
export interface EffectiveQtyMeasurementInput {
  value: number;
}

/**
 * effectiveQty(line, measurement) — BUILD-SPEC.md "Estimate ↔ Schedule
 * integration": when a cost line is linked to a measurement, its
 * quantity is DERIVED from that measurement's value (+ an optional
 * wastage allowance), not hand-typed. The line's own `qty` column is
 * left alone (so unlinking reverts to whatever was last hand-entered)
 * — this function is the single source of truth for "what quantity
 * does this line actually cost against right now".
 *
 * = measurement.value * (1 + (wastage_pct ?? 0) / 100) when a
 *   measurement is linked and provided,
 * else line.qty (the plain hand-entered value) — including when
 *   measurement_id is set but the measurement itself wasn't passed in
 *   (e.g. it was deleted; on delete set null means measurement_id would
 *   already be null in that case, but a defensive fallback costs
 *   nothing here).
 */
export function effectiveQty(
  line: Pick<LineCostInput, "qty" | "measurement_id" | "wastage_pct">,
  measurement: EffectiveQtyMeasurementInput | null | undefined
): number | null {
  if (line.measurement_id && measurement) {
    const wastage = line.wastage_pct ?? 0;
    return measurement.value * (1 + wastage / 100);
  }
  return line.qty;
}

/**
 * lineCost(line, measurement?) = cost_ex_gst if manually set (override),
 * else effectiveQty * rate_ex_gst if both present, else null
 * (unknown/not yet costed). BUILD-SPEC.md: "cost_ex_gst numeric(12,2)
 * nullable (manual override; else computed qty*rate in app)" — Week 7
 * additive: "qty" in that computation is effectiveQty() when a
 * measurement is linked, so a wastage-adjusted quantity flows through
 * to cost automatically without a separate code path.
 *
 * The optional second argument is intentionally omissible — every
 * existing call site (sectionRollup, projectRollup, the UI's
 * per-cell display for unlinked lines) keeps working unchanged; only
 * call sites that actually have the linked measurement in hand need to
 * pass it for the linked-line figure to be accurate.
 */
export function lineCost(
  line: LineCostInput,
  measurement?: EffectiveQtyMeasurementInput | null
): number | null {
  if (line.cost_ex_gst !== null && line.cost_ex_gst !== undefined) {
    return roundMoney(line.cost_ex_gst);
  }
  const qty = effectiveQty(line, measurement);
  if (
    qty !== null &&
    qty !== undefined &&
    line.rate_ex_gst !== null &&
    line.rate_ex_gst !== undefined
  ) {
    return roundMoney(qty * line.rate_ex_gst);
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

/**
 * Sums cost/quoted/actual across a section's (already-filtered,
 * non-deleted) lines.
 *
 * `measurementsById` is optional (Week 7, additive) — a lookup so
 * linked lines' cost reflects effectiveQty() (measurement value +
 * wastage) rather than their raw, possibly-stale `qty` column. Callers
 * that don't pass it (or lines with no measurement_id) behave exactly
 * as before.
 */
export function sectionRollup(
  lines: LineForRollup[],
  measurementsById?: Map<string, EffectiveQtyMeasurementInput>
): SectionRollup {
  let costExGst = 0;
  let quotedExGst = 0;
  let actualExGst = 0;
  let variance = 0;
  let hasVariance = false;

  for (const line of lines) {
    const measurement = line.measurement_id
      ? measurementsById?.get(line.measurement_id) ?? null
      : null;
    const cost = lineCost(line, measurement);
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
  /** Optional (Week 7) — measurement id → measurement, for effectiveQty() on linked lines. */
  measurementsById?: Map<string, EffectiveQtyMeasurementInput>;
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
  measurementsById,
}: ProjectRollupInput): ProjectRollup {
  const { costExGst: allTradesSubtotalExGst, quotedExGst, actualExGst } =
    sectionRollup(lines, measurementsById);
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

// ------------------------------------------------------------
// FF&E — from schedule (Week 6, additive)
// BUILD-SPEC.md "Estimate ↔ Schedule integration" (newest section):
// Schedule (spec register) items are NEVER duplicated as cost lines.
// Instead this computes a read-only "FF&E — from schedule" block: per
// category, qty × best-known price, cascading price_trade (if set)
// else price_rrp (flagged 'placeholder'), with a confidence split.
//
// Pure and dependency-free like the rest of this module — callers pass
// in already-fetched, non-deleted items; this file never touches
// Supabase directly.
// ------------------------------------------------------------

/** Minimal shape needed from an `items` row to compute the FF&E block. */
export interface FfeItemInput {
  id: string;
  category: string;
  quantity: number;
  price_trade: number | null;
  price_rrp: number | null;
  /**
   * Round B additive — takeoff → FF&E quantity link (migration 027:
   * items.measurement_id/wastage_pct/coverage_per_unit). All three are
   * optional so every existing caller/fixture that only ever built a
   * plain { id, category, quantity, price_trade, price_rrp } literal
   * keeps compiling and behaving identically — see ffeRollup()'s doc
   * comment below for exactly when these are consulted.
   */
  measurement_id?: string | null;
  wastage_pct?: number | null;
  coverage_per_unit?: number | null;
}

/**
 * Minimal shape needed from a measurement for the FF&E derived-quantity
 * path — identical shape to lib/item-quantity.ts's
 * DerivedQuantityMeasurementInput (kept as a separate local type here
 * rather than imported, so this module keeps its documented "no
 * Supabase/Next imports, nothing beyond @/types" dependency footprint;
 * lib/item-quantity.ts itself has zero framework dependencies either,
 * so importing it would be safe, but duplicating one 3-line interface
 * is cheaper than adding a new cross-module dependency to this
 * long-lived, heavily-relied-upon file for a single shape).
 */
export interface FfeMeasurementInput {
  value: number;
}

export type FfeConfidence = "quoted" | "placeholder" | "unpriced";

/**
 * Per-item cascade: price_trade (if set) else price_rrp (flagged
 * 'placeholder'), else null ('unpriced'). Mirrors the build spec's
 * "cascade price_trade (if set) else price_rrp (flagged 'placeholder')".
 */
export function ffeBestPrice(item: FfeItemInput): {
  bestPrice: number | null;
  confidence: FfeConfidence;
} {
  if (item.price_trade !== null && item.price_trade !== undefined) {
    return { bestPrice: item.price_trade, confidence: "quoted" };
  }
  if (item.price_rrp !== null && item.price_rrp !== undefined) {
    return { bestPrice: item.price_rrp, confidence: "placeholder" };
  }
  return { bestPrice: null, confidence: "unpriced" };
}

/**
 * Round B additive helper for ffeRollup(): the quantity to actually
 * cost an FF&E item against. Same formula as
 * lib/item-quantity.ts's derivedQuantity() (duplicated rather than
 * imported — see FfeMeasurementInput's doc comment above for why this
 * file avoids a cross-module import for one small shape):
 *   1. adjusted = measurement.value * (1 + (wastage_pct ?? 0) / 100)
 *   2. if coverage_per_unit is set: ceil(adjusted / coverage_per_unit)
 *   3. else: adjusted as-is
 * Falls back to item.quantity when unlinked or the measurement wasn't
 * resolvable, so an item with no link behaves exactly as before this
 * round.
 */
function ffeDerivedQuantity(item: FfeItemInput, measurement: FfeMeasurementInput | null): number {
  if (item.measurement_id && measurement) {
    const wastage = item.wastage_pct ?? 0;
    const adjusted = measurement.value * (1 + wastage / 100);
    if (item.coverage_per_unit !== null && item.coverage_per_unit !== undefined && item.coverage_per_unit > 0) {
      return Math.ceil(adjusted / item.coverage_per_unit);
    }
    return adjusted;
  }
  return item.quantity;
}

export interface FfeCategoryRollup {
  category: string;
  item_count: number;
  /** Sum of qty × bestPrice across the category's priced items (unpriced items contribute 0). */
  total: number;
  /** quoted_total / total, 0 if total is 0. Informational — same idea as the overall split but per-row. */
  quoted_share: number;
  quoted_count: number;
  placeholder_count: number;
  unpriced_count: number;
}

export interface FfeRollup {
  categories: FfeCategoryRollup[];
  /** Sum of every category's total — the "FF&E — from schedule" headline figure, ex GST. */
  total: number;
  quoted_total: number;
  placeholder_total: number;
  item_count: number;
  quoted_count: number;
  placeholder_count: number;
  unpriced_count: number;
  /** quoted_total / total (by $), 0 if total is 0 — drives "Y% quoted / Z% placeholder". */
  quoted_share: number;
  placeholder_share: number;
}

/**
 * Computes the FF&E — from schedule block from a project's (already
 * fetched, non-deleted) items. Grouped by category, each item tagged
 * 'quoted' | 'placeholder' | 'unpriced' per ffeBestPrice() above.
 *
 * A zero/negative-quantity item still counts toward item_count (it's a
 * real schedule line) but contributes $0 to the category total, same
 * as an unpriced item would.
 *
 * Round B additive: `measurementsById` is an OPTIONAL second argument
 * (measurement id → { value }), mirroring sectionRollup()/
 * projectRollup()'s existing `measurementsById` parameter above. When
 * an item has `measurement_id` set AND its measurement is present in
 * this map, the item's line total uses
 * lib/item-quantity.ts-equivalent derived quantity (measurement value
 * × (1 + wastage%), then ceil'd by coverage_per_unit if set) instead of
 * the item's raw `quantity` column — so a takeoff-linked FF&E item's
 * dollar figure stays correct even if `quantity` itself is stale.
 *
 * Backwards compatible: every existing call site that doesn't pass
 * `measurementsById` (or passes items with no measurement_id) computes
 * byte-for-byte the same `item.quantity * bestPrice` as before — the
 * derivation only activates per-item when both a link AND a resolvable
 * measurement are present.
 */
export function ffeRollup(
  items: FfeItemInput[],
  measurementsById?: Map<string, FfeMeasurementInput>
): FfeRollup {
  const byCategory = new Map<string, FfeItemInput[]>();
  for (const item of items) {
    const list = byCategory.get(item.category);
    if (list) list.push(item);
    else byCategory.set(item.category, [item]);
  }

  const categories: FfeCategoryRollup[] = [];
  let total = 0;
  let quotedTotal = 0;
  let placeholderTotal = 0;
  let itemCount = 0;
  let quotedCount = 0;
  let placeholderCount = 0;
  let unpricedCount = 0;

  for (const [category, catItems] of byCategory) {
    let catTotal = 0;
    let catQuotedTotal = 0;
    let catQuotedCount = 0;
    let catPlaceholderCount = 0;
    let catUnpricedCount = 0;

    for (const item of catItems) {
      const { bestPrice, confidence } = ffeBestPrice(item);
      const measurement =
        item.measurement_id ? measurementsById?.get(item.measurement_id) ?? null : null;
      const effectiveQuantity = ffeDerivedQuantity(item, measurement);
      const lineTotal = bestPrice !== null ? effectiveQuantity * bestPrice : 0;
      catTotal += lineTotal;
      if (confidence === "quoted") {
        catQuotedTotal += lineTotal;
        catQuotedCount += 1;
      } else if (confidence === "placeholder") {
        placeholderTotal += lineTotal;
        catPlaceholderCount += 1;
      } else {
        catUnpricedCount += 1;
      }
    }

    categories.push({
      category,
      item_count: catItems.length,
      total: roundMoney(catTotal),
      quoted_share: catTotal > 0 ? roundMoney(catQuotedTotal / catTotal) : 0,
      quoted_count: catQuotedCount,
      placeholder_count: catPlaceholderCount,
      unpriced_count: catUnpricedCount,
    });

    total += catTotal;
    quotedTotal += catQuotedTotal;
    itemCount += catItems.length;
    quotedCount += catQuotedCount;
    placeholderCount += catPlaceholderCount;
    unpricedCount += catUnpricedCount;
  }

  // Sort categories for a stable, predictable UI order (alphabetical by
  // category prefix — the categories table's own sort_order isn't
  // available to this pure function, so the API/UI layer may re-sort
  // against the categories list if a different order is preferred).
  categories.sort((a, b) => a.category.localeCompare(b.category));

  return {
    categories,
    total: roundMoney(total),
    quoted_total: roundMoney(quotedTotal),
    placeholder_total: roundMoney(placeholderTotal),
    item_count: itemCount,
    quoted_count: quotedCount,
    placeholder_count: placeholderCount,
    unpriced_count: unpricedCount,
    quoted_share: total > 0 ? roundMoney(quotedTotal / total) : 0,
    placeholder_share: total > 0 ? roundMoney(placeholderTotal / total) : 0,
  };
}

// ------------------------------------------------------------
// Whole-job summary — all-trades + approved variations + markup (the
// existing projectRollup cascade) THEN FF&E added AFTER markup.
//
// Cascade decision (BUILD-SPEC.md "Estimate ↔ Schedule integration"):
// FF&E client pricing is a SEPARATE pricing lane from the trade
// estimate. The whole-job markup (projects.estimate_markup_pct) is a
// margin the business applies to ITS OWN construction/trade costs
// (cost_lines) — it has no relationship to spec register item
// pricing, which already carries its own per-item markup_pct
// (items.markup_pct, applied elsewhere to compute each item's client
// price from price_trade/price_rrp). Folding FF&E into the
// trade-markup base would double-apply a margin never priced into the
// FF&E figure, and would silently conflate two different profit
// mechanisms the business tracks separately (trade margin vs. product
// margin). So: FF&E's `total` (already the best-known ex-GST product
// cost, NOT yet client-marked-up — items.markup_pct is applied
// elsewhere, e.g. the P&P view/PDF, not by this module) is added to
// the cascade AFTER totalToClientExGst is computed, not folded into
// the pre-markup base like approved variations are. GST is then
// re-derived over the combined (trades + FF&E) total so the headline
// "Total inc GST" still reflects one real GST figure.
// ------------------------------------------------------------

export interface WholeJobSummary {
  /** The existing trades-only rollup (all-trades subtotal, approved variations, markup, GST) — unchanged. */
  trades: ProjectRollup;
  /** The FF&E — from schedule rollup (ex GST, no trade markup applied — see cascade comment above). */
  ffe: FfeRollup;
  /** trades.totalToClientExGst + ffe.total — the combined ex-GST figure BEFORE re-deriving GST. */
  combinedExGst: number;
  /** GST at 10% of combinedExGst. */
  combinedGst: number;
  /** The true whole-job headline: combinedExGst + combinedGst. */
  combinedIncGst: number;
}

/**
 * Folds the FF&E rollup into the whole-job summary AFTER trade markup
 * (see cascade decision above). This is the figure that should replace
 * the Estimate tab's "Estimate total — inc GST" placeholder comment
 * ("FF&E client pricing joins this figure in a later release") once
 * the FF&E block ships.
 */
export function wholeJobSummary(trades: ProjectRollup, ffe: FfeRollup): WholeJobSummary {
  const combinedExGst = roundMoney(trades.totalToClientExGst + ffe.total);
  const combinedGst = roundMoney(combinedExGst * GST_RATE);
  const combinedIncGst = roundMoney(combinedExGst + combinedGst);
  return { trades, ffe, combinedExGst, combinedGst, combinedIncGst };
}
