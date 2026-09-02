import { ffeProductCostUnitPrice } from "./ffe-pricing.ts";
import { derivedQuantity } from "./item-quantity.ts";

export type InvoiceFfeCostingMatchType = "item" | "item_component";
export type InvoiceFfeForecastSource = "saved_estimate" | "live_schedule" | "unpriced";

export interface InvoiceFfeCostingItemInput {
  id: string;
  item_code: string;
  name: string;
  category: string;
  supplier: string | null;
  quantity: number | string;
  unit: string;
  cost_scope: "direct" | "trade_package";
  status: string;
  ordered_at: string | null;
  price_trade: number | string | null;
  price_rrp: number | string | null;
  measurement_id: string | null;
  wastage_pct: number | string | null;
  coverage_per_unit: number | string | null;
}

export interface InvoiceFfeCostingComponentInput {
  id: string;
  item_id: string;
  name: string;
  supplier: string | null;
  supplier_item_code: string | null;
  quantity_per_item: number | string;
  unit: string;
  price_trade: number | string | null;
  ordered_at: string | null;
  deleted_at?: string | null;
}

export interface InvoiceFfeCostingAllocationInput {
  invoice_id: string;
  match_type: "cost_line" | "item" | "item_component";
  match_id: string;
  amount_ex_gst: number | string;
}

export interface InvoiceFfeCostingSnapshotItemInput {
  id: string;
  total_ex_gst?: number | string | null;
  cost_net_minor?: number | null;
}

export interface InvoiceFfeCostingRow {
  match_type: InvoiceFfeCostingMatchType;
  match_id: string;
  parent_item_id: string;
  item_code: string;
  name: string;
  category: string;
  supplier: string | null;
  supplier_item_code: string | null;
  quantity: number;
  unit: string;
  status: string;
  ordered_at: string | null;
  expected_unit_ex_gst: number | null;
  current_expected_ex_gst: number | null;
  forecast_ex_gst: number | null;
  forecast_source: InvoiceFfeForecastSource;
  approved_actual_ex_gst: number;
  remaining_forecast_ex_gst: number | null;
  variance_ex_gst: number | null;
  approved_invoice_count: number;
  pricing_confidence: "quoted" | "placeholder" | "unpriced";
}

function finite(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function addAmount(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, money((map.get(key) ?? 0) + amount));
}

function addInvoice(map: Map<string, Set<string>>, key: string, invoiceId: string): void {
  const ids = map.get(key) ?? new Set<string>();
  ids.add(invoiceId);
  map.set(key, ids);
}

/** Normalises common Australian supplier suffixes so “Reece” matches “Reece Australia Pty Ltd”. */
export function invoiceSupplierKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|australia|australian|group|company|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function invoiceSupplierMatches(
  invoiceSupplier: string | null | undefined,
  candidateSupplier: string | null | undefined
): boolean {
  const invoice = invoiceSupplierKey(invoiceSupplier);
  const candidate = invoiceSupplierKey(candidateSupplier);
  if (!invoice || !candidate) return false;
  return invoice === candidate ||
    (Math.min(invoice.length, candidate.length) >= 4 &&
      (invoice.includes(candidate) || candidate.includes(invoice)));
}

/**
 * Builds the admin-only FF&E costing ledger used while matching supplier
 * invoice lines. A saved item snapshot is the budget benchmark when present;
 * older/legacy versions fall back visibly to the current live schedule.
 */
export function buildInvoiceFfeCostingRows(input: {
  items: InvoiceFfeCostingItemInput[];
  components: InvoiceFfeCostingComponentInput[];
  measurements?: Record<string, number | string>;
  approvedAllocations?: InvoiceFfeCostingAllocationInput[];
  costLineItemIds?: Record<string, string | null>;
  snapshotItems?: InvoiceFfeCostingSnapshotItemInput[];
}): InvoiceFfeCostingRow[] {
  const directItems = input.items.filter((item) => item.cost_scope !== "trade_package");
  const directItemIds = new Set(directItems.map((item) => item.id));
  const itemsById = new Map(directItems.map((item) => [item.id, item]));
  const allComponents = input.components.filter((component) => directItemIds.has(component.item_id));
  const components = allComponents.filter((component) => !component.deleted_at);
  const componentsById = new Map(allComponents.map((component) => [component.id, component]));
  const componentsByParent = new Map<string, InvoiceFfeCostingComponentInput[]>();
  for (const component of components) {
    componentsByParent.set(component.item_id, [
      ...(componentsByParent.get(component.item_id) ?? []),
      component,
    ]);
  }

  const quantityByItem = new Map<string, number>();
  const currentExpectedByItem = new Map<string, number | null>();
  const unitPriceByItem = new Map<string, number | null>();
  for (const item of directItems) {
    const quantity = derivedQuantity(
      {
        quantity: finite(item.quantity) ?? 0,
        measurement_id: item.measurement_id,
        wastage_pct: finite(item.wastage_pct),
        coverage_per_unit: finite(item.coverage_per_unit),
      },
      item.measurement_id && finite(input.measurements?.[item.measurement_id]) !== null
        ? { value: finite(input.measurements?.[item.measurement_id]) as number }
        : null
    ).quantity;
    const price = ffeProductCostUnitPrice({
      price_trade: finite(item.price_trade),
      price_rrp: finite(item.price_rrp),
      cost_scope: item.cost_scope,
    });
    quantityByItem.set(item.id, quantity);
    unitPriceByItem.set(item.id, price);
    currentExpectedByItem.set(item.id, price === null ? null : money(quantity * price));
  }

  const snapshotByItem = new Map<string, number>();
  for (const item of input.snapshotItems ?? []) {
    const minor = item.cost_net_minor;
    if (minor !== null && minor !== undefined && Number.isSafeInteger(minor) && minor >= 0) {
      snapshotByItem.set(item.id, money(minor / 100));
      continue;
    }
    const total = finite(item.total_ex_gst);
    if (total !== null) snapshotByItem.set(item.id, money(Math.max(total, 0)));
  }

  const directActualByItem = new Map<string, number>();
  const componentActualById = new Map<string, number>();
  const invoiceIdsByItem = new Map<string, Set<string>>();
  const invoiceIdsByComponent = new Map<string, Set<string>>();
  for (const allocation of input.approvedAllocations ?? []) {
    const amount = finite(allocation.amount_ex_gst);
    if (amount === null || amount <= 0) continue;
    if (allocation.match_type === "item" && directItemIds.has(allocation.match_id)) {
      addAmount(directActualByItem, allocation.match_id, amount);
      addInvoice(invoiceIdsByItem, allocation.match_id, allocation.invoice_id);
      continue;
    }
    if (allocation.match_type === "cost_line") {
      const itemId = input.costLineItemIds?.[allocation.match_id] ?? null;
      if (itemId && directItemIds.has(itemId)) {
        addAmount(directActualByItem, itemId, amount);
        addInvoice(invoiceIdsByItem, itemId, allocation.invoice_id);
      }
      continue;
    }
    if (allocation.match_type === "item_component") {
      // A previously invoiced component may later be archived. It no longer
      // appears as a selectable row, but its actual must still reduce the
      // parent FF&E allowance.
      const component = componentsById.get(allocation.match_id);
      if (!component) continue;
      addAmount(componentActualById, component.id, amount);
      addInvoice(invoiceIdsByComponent, component.id, allocation.invoice_id);
      addAmount(directActualByItem, component.item_id, amount);
      addInvoice(invoiceIdsByItem, component.item_id, allocation.invoice_id);
    }
  }

  function finishRow(base: Omit<InvoiceFfeCostingRow,
    "forecast_ex_gst" | "forecast_source" | "remaining_forecast_ex_gst" | "variance_ex_gst"
  >, savedForecast: number | null): InvoiceFfeCostingRow {
    const forecast = savedForecast ?? base.current_expected_ex_gst;
    const forecastSource: InvoiceFfeForecastSource = savedForecast !== null
      ? "saved_estimate"
      : base.current_expected_ex_gst !== null
        ? "live_schedule"
        : "unpriced";
    return {
      ...base,
      forecast_ex_gst: forecast,
      forecast_source: forecastSource,
      remaining_forecast_ex_gst: forecast === null
        ? null
        : money(Math.max(forecast - base.approved_actual_ex_gst, 0)),
      variance_ex_gst: forecast === null
        ? null
        : money(base.approved_actual_ex_gst - forecast),
    };
  }

  const rows: InvoiceFfeCostingRow[] = [];
  for (const item of directItems) {
    const unitPrice = unitPriceByItem.get(item.id) ?? null;
    const actual = directActualByItem.get(item.id) ?? 0;
    rows.push(finishRow({
      match_type: "item",
      match_id: item.id,
      parent_item_id: item.id,
      item_code: item.item_code,
      name: item.name,
      category: item.category,
      supplier: item.supplier,
      supplier_item_code: null,
      quantity: quantityByItem.get(item.id) ?? 0,
      unit: item.unit,
      status: item.status,
      ordered_at: item.ordered_at,
      expected_unit_ex_gst: unitPrice,
      current_expected_ex_gst: currentExpectedByItem.get(item.id) ?? null,
      approved_actual_ex_gst: actual,
      approved_invoice_count: invoiceIdsByItem.get(item.id)?.size ?? 0,
      pricing_confidence: finite(item.price_trade) !== null
        ? "quoted"
        : finite(item.price_rrp) !== null
          ? "placeholder"
          : "unpriced",
    }, snapshotByItem.has(item.id) ? snapshotByItem.get(item.id) as number : null));

    for (const component of componentsByParent.get(item.id) ?? []) {
      const componentUnitPrice = finite(component.price_trade);
      const componentQuantity = money(
        (quantityByItem.get(item.id) ?? 0) * (finite(component.quantity_per_item) ?? 0)
      );
      const componentExpected = componentUnitPrice === null
        ? null
        : money(componentQuantity * componentUnitPrice);
      const componentActual = componentActualById.get(component.id) ?? 0;
      rows.push(finishRow({
        match_type: "item_component",
        match_id: component.id,
        parent_item_id: item.id,
        item_code: item.item_code,
        name: component.name,
        category: item.category,
        supplier: component.supplier ?? item.supplier,
        supplier_item_code: component.supplier_item_code,
        quantity: componentQuantity,
        unit: component.unit,
        status: component.ordered_at ? "Ordered" : item.status,
        ordered_at: component.ordered_at,
        expected_unit_ex_gst: componentUnitPrice,
        current_expected_ex_gst: componentExpected,
        approved_actual_ex_gst: componentActual,
        approved_invoice_count: invoiceIdsByComponent.get(component.id)?.size ?? 0,
        pricing_confidence: componentUnitPrice === null ? "unpriced" : "quoted",
      }, null));
    }
  }

  return rows.sort((a, b) => {
    const codeOrder = a.item_code.localeCompare(b.item_code, undefined, { numeric: true });
    if (codeOrder !== 0) return codeOrder;
    if (a.match_type !== b.match_type) return a.match_type === "item" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
