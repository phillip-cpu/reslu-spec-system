import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { ffeRollup, sectionRollup } from "@/lib/estimate";
import type { FfeItemInput, LineForRollup } from "@/lib/estimate";
import {
  calculateProjectFinancialPosition,
  type ProjectFinancialPositionInput,
} from "@/lib/project-financial-position";
import { includesConstructionCosts } from "@/lib/finance/construction-cost-eligibility";
import type { ClientContractType } from "@/types/client-invoices";
import type { ProjectStage } from "@/types/finance";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface CostSectionRow {
  cost_lines: Array<LineForRollup & { deleted_at: string | null }>;
}

/**
 * GET /api/projects/[id]/financial-summary
 *
 * Admin-only read model for the financial position card on the
 * project's Invoices tab. It deliberately reads invoice headers, not
 * allocations, so an invoice split over several destinations is
 * counted once. Voided/rejected supplier invoices and draft/void
 * client invoices are excluded by the pure calculation layer.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access project financials" },
      { status: 403 }
    );
  }

  const [
    { data: project, error: projectError },
    { data: supplierInvoices, error: supplierError },
    { data: clientInvoices, error: clientError },
    { data: billingProfile, error: billingError },
    { data: variations, error: variationsError },
    { data: contractVariations, error: contractVariationsError },
    { data: sections, error: sectionsError },
    { data: items, error: itemsError },
    { data: measurements, error: measurementsError },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id,project_stage")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("invoices")
      .select("status,amount_ex_gst,total")
      .eq("project_id", projectId),
    supabase
      .from("client_invoices")
      .select("status,subtotal_ex_gst,total_inc_gst")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("client_billing_profiles")
      .select("contract_amount_inc_gst,contract_type")
      .eq("project_id", projectId)
      .maybeSingle(),
    supabase
      .from("variations")
      .select("status,cost_ex_gst")
      .eq("project_id", projectId)
      .eq("status", "approved")
      .is("deleted_at", null),
    supabase
      .from("client_contract_variations")
      .select("amount_inc_gst")
      .eq("project_id", projectId)
      .eq("status", "active")
      .is("deleted_at", null),
    supabase
      .from("cost_sections")
      .select(
        "cost_lines(qty,rate_ex_gst,cost_ex_gst,measurement_id,wastage_pct,quoted_to_client_ex_gst,actual_paid_ex_gst,deleted_at)"
      )
      .eq("project_id", projectId),
    supabase
      .from("items")
      .select(
        "id,category,quantity,price_trade,price_rrp,cost_scope,measurement_id,wastage_pct,coverage_per_unit"
      )
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase.from("measurements").select("id,value").eq("project_id", projectId),
  ]);

  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const readError =
    supplierError ??
    clientError ??
    billingError ??
    variationsError ??
    contractVariationsError ??
    sectionsError ??
    itemsError ??
    measurementsError;
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }

  const measurementsById = new Map(
    (measurements ?? []).map((measurement) => [
      measurement.id,
      { value: Number(measurement.value) },
    ])
  );
  const allLines = ((sections ?? []) as unknown as CostSectionRow[]).flatMap(
    (section) => (section.cost_lines ?? []).filter((line) => !line.deleted_at)
  );
  const tradeCostPlan = sectionRollup(allLines, measurementsById).costExGst;
  const estimateVariationCostExGst = (variations ?? []).reduce(
    (sum, variation) => sum + Number(variation.cost_ex_gst ?? 0),
    0
  );
  const approvedVariationsExGst = (contractVariations ?? []).reduce(
    (sum, variation) => sum + Number(variation.amount_inc_gst ?? 0) / 1.1,
    0
  );
  const ffeCostPlan = ffeRollup(
    (items ?? []) as unknown as FfeItemInput[],
    measurementsById
  ).total;
  const constructionCostsIncluded = includesConstructionCosts(
    project.project_stage as ProjectStage,
    (billingProfile?.contract_type ?? null) as ClientContractType | null
  );

  const input: ProjectFinancialPositionInput = {
    supplierInvoices: (supplierInvoices ?? []).map((invoice) => ({
      status: invoice.status,
      amount_ex_gst: Number(invoice.amount_ex_gst),
      total: Number(invoice.total),
    })),
    clientInvoices: (clientInvoices ?? []).map((invoice) => ({
      status: invoice.status,
      subtotal_ex_gst: Number(invoice.subtotal_ex_gst),
      total_inc_gst: Number(invoice.total_inc_gst),
    })),
    originalContractIncGst: billingProfile
      ? Number(billingProfile.contract_amount_inc_gst)
      : null,
    approvedVariationsExGst,
    plannedCostExGst: constructionCostsIncluded
      ? tradeCostPlan + estimateVariationCostExGst + ffeCostPlan
      : 0,
    costPlanRequired: constructionCostsIncluded,
  };

  return NextResponse.json({
    financial_position: calculateProjectFinancialPosition(input),
  });
}
