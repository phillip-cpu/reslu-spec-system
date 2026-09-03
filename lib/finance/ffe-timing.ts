import type {
  OrderByItemInput,
  OrderByResult,
  OrderByStatus,
} from "@/lib/order-by";
import type { FinanceConfidence } from "@/types/finance";

export type FfeForecastTimingSource =
  | "ordered_at"
  | "trade_order_by"
  | "no_lead_time"
  | "no_booking";

export interface FfeForecastTiming {
  plannedDate: string | null;
  timingSource: FfeForecastTimingSource;
  confidence: FinanceConfidence;
  orderByStatus: OrderByStatus | "ordered";
  worksDate: string | null;
  tradeName: string | null;
  sourceId: string | null;
  sourceKind: "visit" | "board_task_booking" | "board_task_requirement" | null;
}

export interface FfePricingInput {
  cost_scope?: "direct" | "trade_package";
  price_trade?: number | null;
  price_rrp?: number | null;
}

export interface FfePricingSummary {
  directItemCount: number;
  quotedItemCount: number;
  placeholderItemCount: number;
  unpricedItemCount: number;
}

/** Mirrors the Estimate price cascade while keeping each confidence band visible. */
export function summarizeFfePricing(items: FfePricingInput[]): FfePricingSummary {
  const directItems = items.filter((item) => item.cost_scope !== "trade_package");
  return {
    directItemCount: directItems.length,
    quotedItemCount: directItems.filter((item) => item.price_trade != null).length,
    placeholderItemCount: directItems.filter(
      (item) => item.price_trade == null && item.price_rrp != null
    ).length,
    unpricedItemCount: directItems.filter(
      (item) => item.price_trade == null && item.price_rrp == null
    ).length,
  };
}

/**
 * Turns the shared procurement engine into Finance timing. Amounts never come
 * from these live rows: they remain frozen in the selected estimate version.
 * An order date is the strongest available cash-timing signal; otherwise the
 * order-by date derived from lead time + the linked trade's works date wins.
 * Missing inputs stay undated instead of being silently guessed.
 */
export function buildFfeForecastTimings(
  items: OrderByItemInput[],
  orderBy: OrderByResult[]
): Record<string, FfeForecastTiming> {
  const orderByByItemId = new Map(orderBy.map((row) => [row.item_id, row]));
  const timings: Record<string, FfeForecastTiming> = {};

  for (const item of items) {
    if (item.cost_scope === "trade_package") continue;
    if (item.ordered_at) {
      timings[item.id] = {
        plannedDate: item.ordered_at,
        timingSource: "ordered_at",
        confidence: "high",
        orderByStatus: "ordered",
        worksDate: null,
        tradeName: null,
        sourceId: null,
        sourceKind: null,
      };
      continue;
    }

    const result = orderByByItemId.get(item.id);
    if (result?.order_by) {
      timings[item.id] = {
        plannedDate: result.order_by,
        timingSource: "trade_order_by",
        confidence: "medium",
        orderByStatus: result.status,
        worksDate: result.works_date,
        tradeName: result.required_trade_role ?? result.matched_preset?.name ?? null,
        sourceId: result.source?.source_id ?? null,
        sourceKind: result.source?.source_kind ?? null,
      };
      continue;
    }

    const timingSource = result?.status === "no_lead_time"
      ? "no_lead_time"
      : "no_booking";
    timings[item.id] = {
      plannedDate: null,
      timingSource,
      confidence: "unknown",
      orderByStatus: result?.status ?? "no_booking",
      worksDate: result?.works_date ?? null,
      tradeName: result?.matched_preset?.name ?? null,
      sourceId: result?.source?.source_id ?? null,
      sourceKind: result?.source?.source_kind ?? null,
    };
  }

  return timings;
}
