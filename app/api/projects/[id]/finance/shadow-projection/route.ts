import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { buildEstimatePlanContributions } from "@/lib/finance/baseline";
import { buildClientClaimContributions } from "@/lib/finance/client-claims";
import {
  financeShadowProjectionEnabled,
} from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { calculateShadowProjection } from "@/lib/finance/projection";
import { isIsoDate } from "@/lib/finance/readiness";
import { buildSectionForecastDates } from "@/lib/finance/schedule-cost-timing";
import { loadProjectFfeForecastTiming } from "@/lib/finance/ffe-timing-server";
import { includesConstructionCosts } from "@/lib/finance/construction-cost-eligibility";
import { summarizeForecastSchedule } from "@/lib/finance/forecast-readiness";
import {
  reconcileSupplierInvoiceActuals,
  type SupplierCashInvoice,
} from "@/lib/finance/supplier-actuals";
import { createClient } from "@/lib/supabase/server";
import type { FinanceShadowProjectionRequest, ProjectFinanceProfile } from "@/types/finance";
import type { FinanceEstimateSnapshot } from "@/lib/finance/baseline";
import type {
  ClientBillingProfile,
  ClientContractVariation,
  ClientInvoice,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "@/types/client-invoices";

export const runtime = "nodejs";

/**
 * Deterministic, non-persisting M1 shadow calculation. Timing overrides
 * affect only this response and cannot change baseline or project data.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeShadowProjectionEnabled()) {
    return NextResponse.json({ error: "Finance shadow projection is not enabled" }, { status: 404 });
  }

  const permission = await hasFinanceCapability(
    supabase,
    "finance.view_project",
    projectId
  );
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) {
    return NextResponse.json({ error: "Project finance access denied" }, { status: 403 });
  }

  let body: FinanceShadowProjectionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isIsoDate(body.as_of_date)) {
    return NextResponse.json(
      { error: "as_of_date must be an ISO calendar date" },
      { status: 400 }
    );
  }
  const openingCashMinor = body.opening_cash_minor ?? 0;
  if (!Number.isSafeInteger(openingCashMinor)) {
    return NextResponse.json(
      { error: "opening_cash_minor must be a safe integer" },
      { status: 400 }
    );
  }
  const timingOverrides = body.timing_overrides ?? {};
  if (
    Object.values(timingOverrides).some(
      (value) => typeof value !== "string" || !isIsoDate(value)
    )
  ) {
    return NextResponse.json(
      { error: "Every timing override must be an ISO calendar date" },
      { status: 400 }
    );
  }

  let estimateQuery = supabase
    .from("estimate_versions")
    .select("id,label,snapshot")
    .eq("project_id", projectId);
  estimateQuery = body.estimate_version_id
    ? estimateQuery.eq("id", body.estimate_version_id)
    : estimateQuery.order("created_at", { ascending: false }).limit(1);

  const [
    { data: project, error: projectError },
    { data: profile, error: profileError },
    { data: estimateRows, error: estimateError },
    { data: billingProfile, error: billingError },
    { data: paymentSchedule, error: scheduleError },
    { data: schedulePhases, error: phaseError },
    { data: costSections, error: costSectionError },
    { data: clientInvoices, error: invoiceError },
    { data: contractVariations, error: contractVariationError },
    { data: supplierInvoices, error: supplierInvoiceError },
  ] = await Promise.all([
    supabase.from("projects").select("id,project_stage").eq("id", projectId).maybeSingle(),
    supabase
      .from("project_finance_profiles")
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle(),
    estimateQuery,
    supabase
      .from("client_billing_profiles")
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle(),
    supabase
      .from("client_payment_schedule")
      .select("*")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("sort"),
    supabase
      .from("schedule_phases")
      .select("id,name,start_date,end_date,sort")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("sort"),
    supabase
      .from("cost_sections")
      .select("id,forecast_phase_id")
      .eq("project_id", projectId),
    supabase
      .from("client_invoices")
      .select("*")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .neq("status", "void"),
    supabase
      .from("client_contract_variations")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "active")
      .is("deleted_at", null),
    supabase
      .from("invoices")
      .select("id,project_id,supplier,invoice_number,invoice_date,due_date,amount_ex_gst,gst,total,status,payment_status,amount_paid,paid_at,proposed_match_type,proposed_match_id,invoice_allocations(id,match_type,match_id,amount_ex_gst)")
      .eq("project_id", projectId)
      .eq("status", "approved"),
  ]);

  if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const readError = profileError ?? estimateError ?? billingError ?? scheduleError ?? phaseError ?? costSectionError ?? invoiceError ?? contractVariationError ?? supplierInvoiceError;
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!profile) {
    return NextResponse.json(
      { error: "Finance profile is unavailable. Apply migration 080." },
      { status: 503 }
    );
  }
  const constructionCostsIncluded = includesConstructionCosts(
    project.project_stage as import("@/types/finance").ProjectStage,
    (billingProfile as ClientBillingProfile | null)?.contract_type
  );
  const estimate = estimateRows?.[0];
  if (constructionCostsIncluded && !estimate) {
    return NextResponse.json(
      { error: "Save an estimate version before running a shadow projection" },
      { status: 409 }
    );
  }

  try {
    const ffeTiming = await loadProjectFfeForecastTiming(supabase, [projectId]);
    const estimateSnapshot = (estimate?.snapshot ?? null) as FinanceEstimateSnapshot | null;
    const estimateFfeItems = Array.isArray(estimateSnapshot?.ffe_items)
      ? estimateSnapshot.ffe_items
      : null;
    const scheduleSummary = summarizeForecastSchedule(schedulePhases ?? []);
    const sectionDates = buildSectionForecastDates({
      sections: costSections ?? [],
      phases: schedulePhases ?? [],
    });
    const estimateContributions = constructionCostsIncluded && estimate
      ? buildEstimatePlanContributions({
          projectId,
          estimateVersionId: estimate.id,
          snapshot: estimateSnapshot as FinanceEstimateSnapshot,
          sectionDates,
          itemTimings: ffeTiming.timings,
          timingOverrides,
        })
      : [];
    const clientClaimContributions = buildClientClaimContributions({
      projectId,
      profile: (billingProfile as ClientBillingProfile | null) ?? null,
      schedule: (paymentSchedule ?? []) as ClientPaymentScheduleItem[],
      phases: (schedulePhases ?? []) as ClientSchedulePhase[],
      invoices: (clientInvoices ?? []) as ClientInvoice[],
      contractVariations: (contractVariations ?? []) as ClientContractVariation[],
    });
    const supplierReconciliation = reconcileSupplierInvoiceActuals({
      contributions: estimateContributions,
      invoices: (supplierInvoices ?? []) as unknown as SupplierCashInvoice[],
      itemCategories: ffeTiming.itemCategories,
    });
    const contributions = [
      ...supplierReconciliation.contributions,
      ...clientClaimContributions,
    ];
    const projection = calculateShadowProjection({
      asOfDate: body.as_of_date,
      openingCashMinor,
      contributions,
    });
    const typedProfile = profile as ProjectFinanceProfile;
    return NextResponse.json({
      mode: "shadow",
      persisted: false,
      committed_base_eligible: typedProfile.finance_state === "active",
      finance_state: typedProfile.finance_state,
      source: {
        estimate_version_id: estimate?.id ?? null,
        estimate_label: estimate?.label ?? null,
        timing_override_count: Object.keys(timingOverrides).length,
        schedule_link_count: Object.keys(sectionDates).length,
        cost_section_count: costSections?.length ?? 0,
        schedule_phase_count: scheduleSummary.phaseCount,
        schedule_dated_phase_count: scheduleSummary.datedPhaseCount,
        latest_schedule_date: scheduleSummary.latestScheduleDate,
        ffe_direct_item_count: ffeTiming.directItemCount,
        ffe_timing_link_count: ffeTiming.datedItemCount,
        ffe_quoted_item_count: ffeTiming.quotedItemCount,
        ffe_placeholder_item_count: ffeTiming.placeholderItemCount,
        ffe_unpriced_item_count: ffeTiming.unpricedItemCount,
        estimate_has_item_level_ffe: estimateFfeItems !== null,
        estimate_ffe_direct_item_count:
          estimateFfeItems?.filter((item) => item.cost_scope !== "trade_package").length ?? 0,
        client_claim_count: clientClaimContributions.length,
        construction_costs_included: constructionCostsIncluded,
        reconciled_supplier_invoice_count: supplierReconciliation.includedInvoices,
        opening_cash_source:
          body.opening_cash_minor === undefined ? "not_configured" : "request_preview",
      },
      projection,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not calculate projection" },
      { status: 400 }
    );
  }
}
