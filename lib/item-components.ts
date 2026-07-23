import type { ItemComponent } from "@/types/item-components";

export type AssemblyProcurementStatus =
  | "not_ordered"
  | "partially_ordered"
  | "ordered"
  | "partially_delivered"
  | "delivered";

export function assemblyUnitCost(
  components: Array<Pick<ItemComponent, "quantity_per_item" | "price_trade">>
): number | null {
  if (components.length === 0 || components.some((component) => component.price_trade === null)) {
    return null;
  }
  const cents = components.reduce(
    (sum, component) =>
      sum + Math.round(Number(component.quantity_per_item) * Number(component.price_trade) * 100),
    0
  );
  return cents / 100;
}

export function assemblyProcurementStatus(
  components: Array<Pick<ItemComponent, "ordered_at" | "delivered_at">>
): AssemblyProcurementStatus {
  if (components.length === 0) return "not_ordered";
  const ordered = components.filter((component) => component.ordered_at).length;
  const delivered = components.filter((component) => component.delivered_at).length;
  if (delivered === components.length) return "delivered";
  if (delivered > 0) return "partially_delivered";
  if (ordered === components.length) return "ordered";
  if (ordered > 0) return "partially_ordered";
  return "not_ordered";
}

export function assemblyProcurementLabel(
  components: Array<Pick<ItemComponent, "ordered_at" | "delivered_at">>
): string {
  const status = assemblyProcurementStatus(components);
  const ordered = components.filter((component) => component.ordered_at).length;
  const delivered = components.filter((component) => component.delivered_at).length;
  if (status === "delivered") return "All parts delivered";
  if (status === "partially_delivered") {
    return `${delivered}/${components.length} parts delivered`;
  }
  if (status === "ordered") return "All parts ordered";
  if (status === "partially_ordered") {
    return `${ordered}/${components.length} parts ordered`;
  }
  return "Parts not ordered";
}
