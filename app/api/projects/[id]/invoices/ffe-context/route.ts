import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import {
  buildInvoiceFfeCostingRows,
  type InvoiceFfeCostingAllocationInput,
  type InvoiceFfeCostingComponentInput,
  type InvoiceFfeCostingItemInput,
  type InvoiceFfeCostingSnapshotItemInput,
} from "@/lib/invoice-ffe-costing";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface FinanceProfileRow {
  active_baseline: { estimate_version_id: string } | Array<{ estimate_version_id: string }> | null;
}

interface EstimateVersionRow {
  id: string;
  label: string;
  snapshot: { ffe_items?: InvoiceFfeCostingSnapshotItemInput[] } | null;
}

interface ApprovedInvoiceRow {
  id: string;
  invoice_allocations: Array<{
    match_type: "cost_line" | "item" | "item_component";
    match_id: string;
    amount_ex_gst: number | string;
  }>;
}

/**
 * Admin-only read model for supplier-invoice matching. It joins the live FF&E
 * schedule, a frozen Estimate/Finance benchmark and approved invoice actuals
 * without exposing any of those financial fields through the team-visible
 * specification endpoint.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access invoice costing" },
      { status: 403 }
    );
  }

  const { data: financeProfile, error: profileError } = await supabase
    .from("project_finance_profiles")
    .select("active_baseline:forecast_baselines(estimate_version_id)")
    .eq("project_id", projectId)
    .maybeSingle();
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  const typedProfile = financeProfile as unknown as FinanceProfileRow | null;
  const activeBaseline = Array.isArray(typedProfile?.active_baseline)
    ? typedProfile?.active_baseline[0] ?? null
    : typedProfile?.active_baseline ?? null;
  const activeEstimateVersionId = activeBaseline?.estimate_version_id ?? null;

  let estimateQuery = supabase
    .from("estimate_versions")
    .select("id,label,snapshot")
    .eq("project_id", projectId);
  estimateQuery = activeEstimateVersionId
    ? estimateQuery.eq("id", activeEstimateVersionId).limit(1)
    : estimateQuery.order("created_at", { ascending: false }).limit(1);

  const [
    itemsResult,
    componentsResult,
    measurementsResult,
    invoicesResult,
    estimateResult,
  ] = await Promise.all([
    supabase
      .from("items")
      .select("id,item_code,name,category,supplier,quantity,unit,cost_scope,status,ordered_at,price_trade,price_rrp,measurement_id,wastage_pct,coverage_per_unit")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("item_components")
      .select("id,item_id,name,supplier,supplier_item_code,quantity_per_item,unit,price_trade,ordered_at,deleted_at,items!inner(project_id,cost_scope,deleted_at)")
      .eq("items.project_id", projectId)
      .neq("items.cost_scope", "trade_package")
      .is("items.deleted_at", null),
    supabase
      .from("measurements")
      .select("id,value")
      .eq("project_id", projectId),
    supabase
      .from("invoices")
      .select("id,invoice_allocations(match_type,match_id,amount_ex_gst)")
      .eq("project_id", projectId)
      .eq("status", "approved"),
    estimateQuery,
  ]);

  const readError = itemsResult.error ?? componentsResult.error ??
    measurementsResult.error ?? invoicesResult.error ?? estimateResult.error;
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  const estimate = ((estimateResult.data ?? [])[0] ?? null) as EstimateVersionRow | null;
  const snapshotItems = estimate?.snapshot?.ffe_items ?? [];
  const approvedAllocations = ((invoicesResult.data ?? []) as unknown as ApprovedInvoiceRow[])
    .flatMap((invoice): InvoiceFfeCostingAllocationInput[] =>
      (invoice.invoice_allocations ?? []).map((allocation) => ({
        invoice_id: invoice.id,
        ...allocation,
      }))
    );

  const rows = buildInvoiceFfeCostingRows({
    items: (itemsResult.data ?? []) as unknown as InvoiceFfeCostingItemInput[],
    components: (componentsResult.data ?? []).map((row) => {
      const { items: _items, ...component } = row as unknown as InvoiceFfeCostingComponentInput & {
        items: unknown;
      };
      void _items;
      return component;
    }),
    measurements: Object.fromEntries(
      (measurementsResult.data ?? []).map((measurement) => [measurement.id, measurement.value])
    ),
    approvedAllocations,
    snapshotItems,
  });

  return NextResponse.json({
    benchmark: {
      estimate_version_id: estimate?.id ?? null,
      estimate_label: estimate?.label ?? null,
      source: activeEstimateVersionId ? "active_finance_baseline" : estimate ? "latest_estimate" : "live_schedule",
      item_level_saved: snapshotItems.length > 0,
    },
    summary: {
      direct_item_count: rows.filter((row) => row.match_type === "item").length,
      component_count: rows.filter((row) => row.match_type === "item_component").length,
      invoiced_row_count: rows.filter((row) => row.approved_invoice_count > 0).length,
      saved_forecast_row_count: rows.filter((row) => row.forecast_source === "saved_estimate").length,
    },
    rows,
  });
}
