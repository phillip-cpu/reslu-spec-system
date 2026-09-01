import {
  ffeBestPrice,
  type FfeItemInput,
} from "./estimate.ts";
import type { FfeRollup } from "../types/index.ts";
import type { EstimateFfeItemSnapshot } from "../types/phase-12a-a.ts";

export interface EstimateFfeSnapshotInput extends FfeItemInput {
  item_code: string;
  name: string;
  lead_time_weeks: number | null;
  ordered_at: string | null;
}

function dollarsToMinor(value: number): number {
  const minor = Math.round((value + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error("FF&E amount exceeds safe minor units");
  return Math.max(minor, 0);
}

/** Preserves a target cent total across weighted rows, including the remainder. */
function apportionMinor(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(weight, 0), 0);
  if (weightTotal <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => total * Math.max(weight, 0) / weightTotal);
  const shares = exact.map(Math.floor);
  const remainder = total - shares.reduce((sum, share) => sum + share, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) {
    shares[order[index % order.length].index] += 1;
  }
  return shares;
}

/**
 * Freezes item identities and cent-exact cost/cash shares alongside the
 * existing category rollup. The category remains the approved total; item
 * shares make timing and invoice replacement possible without rounding drift.
 */
export function buildEstimateFfeItemSnapshots(
  items: EstimateFfeSnapshotInput[],
  ffe: FfeRollup
): EstimateFfeItemSnapshot[] {
  const snapshots = items
    .filter((item) => item.cost_scope !== "trade_package")
    .map((item): EstimateFfeItemSnapshot => {
      const { bestPrice, confidence } = ffeBestPrice(item);
      const total = bestPrice === null ? 0 : Number(item.quantity) * bestPrice;
      const totalExGst = Math.round((total + Number.EPSILON) * 100) / 100;
      return {
        id: item.id,
        item_code: item.item_code,
        name: item.name,
        category: item.category,
        quantity: Number(item.quantity),
        cost_scope: "direct",
        unit_price_ex_gst: bestPrice,
        total_ex_gst: totalExGst,
        cost_net_minor: 0,
        cash_gross_minor: 0,
        pricing_confidence: confidence,
        lead_time_weeks_at_snapshot: item.lead_time_weeks,
        ordered_at_snapshot: item.ordered_at,
      };
    });

  const approvedNetByCategory = new Map(
    ffe.categories.map((category) => [category.category, dollarsToMinor(category.total)])
  );
  const categories = [...new Set(snapshots.map((item) => item.category))];
  for (const category of categories) {
    const indexes = snapshots
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.category === category && item.total_ex_gst > 0);
    if (indexes.length === 0) continue;
    const weights = indexes.map(({ item }) => dollarsToMinor(item.total_ex_gst));
    const approvedNet = approvedNetByCategory.get(category) ??
      weights.reduce((sum, weight) => sum + weight, 0);
    const approvedGross = Math.round(approvedNet * 1.1);
    const netShares = apportionMinor(approvedNet, weights);
    const grossShares = apportionMinor(approvedGross, weights);
    indexes.forEach(({ index }, shareIndex) => {
      snapshots[index].cost_net_minor = netShares[shareIndex];
      snapshots[index].cash_gross_minor = grossShares[shareIndex];
    });
  }

  return snapshots;
}
