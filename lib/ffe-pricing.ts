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
 * The best-known cost (trade, then RRP placeholder) receives the item's
 * explicit cost-plus markup. A missing markup deliberately means 0%,
 * preserving legacy pricing and intentional zero rates. No trade-estimate
 * markup or GST is applied in this pricing lane.
 */
export function ffeClientQuoteUnitPrice(item: FfePriceInput): number | null {
  const cost = ffeProductCostUnitPrice(item);
  return cost === null ? null : cost * (1 + (item.markup_pct ?? 0) / 100);
}

/**
 * Best-known FF&E product cost used by estimate and procurement summaries.
 *
 * A supplier/trade price is authoritative when present. Until then, RRP is an
 * explicit placeholder cost. Keeping this
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
