import type { CreateCostLineInput } from "@/types";

export const DELIVERY_ALLOWANCE_DESCRIPTION = "Delivery allowance";

const DELIVERY_WORDS = /\b(delivery|freight|shipping|courier|cartage|transport)\b/i;

/** Supplier descriptions vary, but these terms are strong enough to
 * switch the matching UI into its delivery-safe path. A human still
 * chooses the project allowance before any money is applied. */
export function isDeliveryDescription(description: string | null | undefined): boolean {
  return DELIVERY_WORDS.test(description ?? "");
}

/** A quote-time delivery allowance is a normal project financial line.
 * Its reusable-product link is deliberately absent: delivery belongs
 * to this project, not to the catalogue price of an FF&E product. */
export function deliveryAllowanceLineInput(): CreateCostLineInput & {
  line_kind: "delivery_allowance";
} {
  return {
    description: DELIVERY_ALLOWANCE_DESCRIPTION,
    qty: 1,
    unit: "allowance",
    rate_ex_gst: null,
    cost_ex_gst: null,
    quoted_to_client_ex_gst: null,
    actual_paid_ex_gst: null,
    quote_status: null,
    item_id: null,
    notes:
      "Quoted delivery allowance. Approved supplier freight is recorded separately as Actual delivery.",
    line_kind: "delivery_allowance",
  };
}

export function deliveryVariance(
  allowanceExGst: number | null | undefined,
  actualDeliveryExGst: number | null | undefined
): number | null {
  if (allowanceExGst === null || allowanceExGst === undefined) return null;
  if (actualDeliveryExGst === null || actualDeliveryExGst === undefined) return null;
  return Math.round((allowanceExGst - actualDeliveryExGst) * 100) / 100;
}
