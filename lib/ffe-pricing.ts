export const DEFAULT_FFE_MARKUP_PERCENT = 30;

export interface FfePriceInput {
  price_trade: number | null;
  price_rrp: number | null;
  markup_pct?: number | null;
  cost_scope?: "direct" | "trade_package";
}

/**
 * Client-facing FF&E unit price for estimate/quote summaries.
 *
 * Trade cost receives the item's explicit markup. A missing markup is
 * deliberately treated as 0% so existing rows created before the 30%
 * default are not repriced unexpectedly. RRP remains an unmarked-up
 * placeholder until a real trade cost is known, matching the existing
 * pricing confidence cascade.
 */
export function ffeClientQuoteUnitPrice(item: FfePriceInput): number | null {
  if (item.cost_scope === "trade_package") return null;
  if (item.price_trade !== null && item.price_trade !== undefined) {
    return item.price_trade * (1 + (item.markup_pct ?? 0) / 100);
  }
  if (item.price_rrp !== null && item.price_rrp !== undefined) {
    return item.price_rrp;
  }
  return null;
}

/**
 * Best-known FF&E product cost used by estimate and procurement summaries.
 *
 * A supplier/trade price is authoritative when present. Until then, RRP is an
 * explicit placeholder cost (and therefore carries no margin). Keeping this
 * cascade beside ffeClientQuoteUnitPrice prevents Procurement, Estimate and
 * saved Finance baselines from silently producing different totals.
 */
export function ffeProductCostUnitPrice(item: FfePriceInput): number | null {
  if (item.cost_scope === "trade_package") return null;
  if (item.price_trade !== null && item.price_trade !== undefined) {
    return item.price_trade;
  }
  if (item.price_rrp !== null && item.price_rrp !== undefined) {
    return item.price_rrp;
  }
  return null;
}
