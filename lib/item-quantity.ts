// ============================================================
// RESLU Spec System — Round B: item quantity derived from a linked
// measurement (takeoff → FF&E link).
// BUILD-SPEC.md "Pricing division — Estimates = labour, FF&E =
// products" (takeoff→FF&E links half).
//
// Deliberately mirrors lib/estimate.ts's effectiveQty()/lineCost()
// shape (pure, dependency-free, no Supabase/Next imports) so the same
// "linked figure vs. last-hand-typed figure" mental model applies to
// spec-register items as already applies to estimate cost lines —
// same UX, same math shape, different table. See that file's own
// effectiveQty() doc comment for the fuller rationale on why the raw
// column (items.quantity here, cost_lines.qty there) is left alone by
// a link rather than overwritten.
// ============================================================

/** Minimal shape needed from an item to compute derivedQuantity() — a subset of the (protected) Item type. */
export interface DerivedQuantityItemInput {
  quantity: number;
  measurement_id: string | null;
  wastage_pct: number | null;
  coverage_per_unit: number | null;
}

/** Minimal shape needed from a measurement — same shape lib/estimate.ts's EffectiveQtyMeasurementInput uses. */
export interface DerivedQuantityMeasurementInput {
  value: number;
}

export interface DerivedQuantityResult {
  /** The quantity to actually use (falls back to item.quantity when unlinked/measurement missing). */
  quantity: number;
  /** true when this figure came from a linked measurement, not the hand-typed items.quantity column. */
  linked: boolean;
  /** Wastage-adjusted measurement value BEFORE any coverage conversion — only meaningful when linked is true. */
  rawAdjustedValue: number | null;
}

/**
 * derivedQuantity(item, measurement) — BUILD-SPEC.md takeoff→FF&E
 * links: when an item is linked to a measurement, its display/costing
 * quantity is DERIVED, not hand-typed:
 *
 *   1. adjusted = measurement.value * (1 + (wastage_pct ?? 0) / 100)
 *   2. if coverage_per_unit is set: quantity = ceil(adjusted / coverage_per_unit)
 *      ("boxes/lengths to buy" — e.g. adjusted=12.4 m², coverage=1.44
 *      m²/box → ceil(8.611) = 9 boxes)
 *   3. else: quantity = adjusted as-is (the item IS sold by the
 *      measurement's own unit — e.g. a paint job priced per m²)
 *
 * Falls back to item.quantity (the plain hand-entered value) when
 * unlinked, OR when linked but the measurement itself wasn't passed in
 * (e.g. it was deleted — items.measurement_id is ON DELETE SET NULL so
 * this defensive fallback should be unreachable in practice, but costs
 * nothing to keep, same reasoning as lib/estimate.ts's effectiveQty()).
 *
 * This function NEVER mutates items.quantity — that column is only
 * ever written by an explicit PATCH, same "unlink reverts to whatever
 * was last hand-entered" behaviour as the estimate module's
 * cost_lines.qty. Callers that want the derived figure persisted onto
 * the row (e.g. so CSV export / the builder PDF show a real number
 * without re-deriving) must do that as an explicit separate write —
 * this module has no side effects at all.
 */
export function derivedQuantity(
  item: DerivedQuantityItemInput,
  measurement: DerivedQuantityMeasurementInput | null | undefined
): DerivedQuantityResult {
  if (item.measurement_id && measurement) {
    const wastage = item.wastage_pct ?? 0;
    const adjusted = measurement.value * (1 + wastage / 100);
    const quantity =
      item.coverage_per_unit !== null && item.coverage_per_unit !== undefined && item.coverage_per_unit > 0
        ? Math.ceil(adjusted / item.coverage_per_unit)
        : adjusted;
    return { quantity, linked: true, rawAdjustedValue: adjusted };
  }
  return { quantity: item.quantity, linked: false, rawAdjustedValue: null };
}

/**
 * Short display note for the derived-quantity UI, e.g. "linked · +10%"
 * or "linked · +10% · 9 boxes". Pure formatting helper — the actual
 * number is derivedQuantity()'s job; this just describes HOW it was
 * computed for the "linked · +10%" caption BUILD-SPEC.md's Estimate ↔
 * Schedule integration UX already uses for cost lines (mirrored here
 * for items).
 */
export function derivedQuantityNote(
  item: Pick<DerivedQuantityItemInput, "wastage_pct" | "coverage_per_unit">,
  result: DerivedQuantityResult
): string | null {
  if (!result.linked) return null;
  const wastage = item.wastage_pct ?? 0;
  const parts = ["linked"];
  if (wastage > 0) parts.push(`+${wastage}%`);
  if (item.coverage_per_unit !== null && item.coverage_per_unit !== undefined) {
    parts.push(`${result.quantity} units`);
  }
  return parts.join(" · ");
}
