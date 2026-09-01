import { GST_RATE, roundMoney } from "./estimate.ts";

export type FfePriceInputResult =
  | { priceRrpExGst: null; error: null }
  | { priceRrpExGst: null; error: string }
  | { priceRrpExGst: number; error: null };

/**
 * Converts the staff-facing quick-add price to the canonical price_rrp basis.
 * Item estimates and CSV exports treat price_rrp as ex GST, while supplier
 * websites normally show GST-inclusive retail prices.
 */
export function normalizeFfePriceInput(
  raw: string,
  includesGst: boolean
): FfePriceInputResult {
  const trimmed = raw.trim();
  if (!trimmed) return { priceRrpExGst: null, error: null };

  const entered = Number(trimmed);
  if (!Number.isFinite(entered) || entered <= 0) {
    return {
      priceRrpExGst: null,
      error: "Enter a price greater than $0, or leave it blank for follow-up.",
    };
  }

  return {
    priceRrpExGst: roundMoney(
      includesGst ? entered / (1 + GST_RATE) : entered
    ),
    error: null,
  };
}
