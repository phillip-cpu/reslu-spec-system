import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import {
  financeFoundationEnabled,
  financeShadowProjectionEnabled,
} from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { calculateShadowProjection } from "@/lib/finance/projection";
import {
  buildEstimatePlanContributions,
  type FinanceEstimateSnapshot,
} from "@/lib/finance/baseline";
import { buildCompanyClientClaimPortfolio } from "@/lib/finance/company-client-claims";
import { generateRecurringContributions } from "@/lib/finance/recurrence";
import { isIsoDate } from "@/lib/finance/readiness";
import { buildSectionForecastDates } from "@/lib/finance/schedule-cost-timing";
import { includesConstructionCosts } from "@/lib/finance/construction-cost-eligibility";
import { createClient } from "@/lib/supabase/server";
import type {
  FinanceCockpitProject,
  FinanceConfidence,
  FinanceContributionInput,
  FinanceRecurringCommitment,
  ProjectFinanceState,
} from "@/types/finance";
import type {
  ClientBillingProfile,
  ClientInvoice,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "@/types/client-invoices";

export const runtime = "nodejs";

type ProfileRow = {
  project_id: string;
  finance_state: ProjectFinanceState;
  active_baseline_id: string | null;
  project: { id: string; name: string; job_number: string | null } | null;
  active_baseline: {
    id: string;
    effective_date: string;
    estimate_version_id: string;
    created_at: string;
  } | null;
};

type ForecastLineRow = {
  id: string;
  baseline_id: string;
  project_id: string;
  contribution_key: string;
  direction: "inflow" | "outflow";
  source_type: string;
  source_record_id: string | null;
  source_version_id: string | null;
  description: string;
  dimension: Record<string, unknown> | null;
  planned_net_minor: number | string;
  committed_net_minor: number | string;
  actual_accrued_net_minor: number | string;
  actual_paid_net_minor: number | string;
  planned_date: string | null;
  committed_date: string | null;
  actual_due_date: string | null;
  actual_paid_date: string | null;
  confidence: FinanceConfidence;
};

type ClaimProjectRow = {
  id: string;
  name: string;
  job_number: string | null;
  project_stage: import("@/types/finance").ProjectStage;
};

type EstimateVersionRow = {
  id: string;
  project_id: string;
  snapshot: FinanceEstimateSnapshot;
  created_at: string;
};

type CostSectionForecastRow = {
  id: string;
  project_id: string;
  forecast_phase_id: string | null;
};

function safeMinor(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside safe minor-unit range`);
  }
  return parsed;
}

function toContribution(
  line: ForecastLineRow,
  projectName: string,
  sectionDates: Record<string, string>
): FinanceContributionInput {
  const sectionId =
    typeof line.dimension?.section_id === "string"
      ? line.dimension.section_id
      : null;
  const scheduleDate = sectionId ? sectionDates[sectionId] ?? null : null;
  return {
    contributionKey: line.contribution_key,
    direction: line.direction,
    description: line.description,
    plannedMinor: safeMinor(line.planned_net_minor, `${line.id}.planned`),
    committedMinor: safeMinor(line.committed_net_minor, `${line.id}.committed`),
    actualAccruedMinor: safeMinor(
      line.actual_accrued_net_minor,
      `${line.id}.actual_accrued`
    ),
    actualPaidMinor: safeMinor(line.actual_paid_net_minor, `${line.id}.actual_paid`),
    plannedDate: scheduleDate ?? line.planned_date,
    committedDate: line.committed_date,
    actualDueDate: line.actual_due_date,
    actualPaidDate: line.actual_paid_date,
    baseEligible: true,
    confidence: scheduleDate ? "medium" : line.confidence,
    sourceTrace: {
      project_id: line.project_id,
      project_name: projectName,
      forecast_line_id: line.id,
      source_type: line.source_type,
      source_record_id: line.source_record_id,
      source_version_id: line.source_version_id,
      dimension: line.dimension ?? {},
      timing_source: scheduleDate ? "construction_schedule" : "baseline",
    },
  };
}

function effectiveContributionExposure(contribution: FinanceContributionInput): number {
  const planned = contribution.plannedMinor;
  const committed = contribution.committedMinor ?? 0;
  const accrued = contribution.actualAccruedMinor ?? 0;
  return committed > 0 ? Math.max(committed, accrued) : Math.max(planned, accrued);
}

function hasContributionDate(contribution: FinanceContributionInput): boolean {
  return Boolean(
    contribution.plannedDate ||
      contribution.committedDate ||
      contribution.actualDueDate ||
      contribution.actualPaidDate
  );
}

/**
 * Read-only company cash cockpit. Locked cost baselines remain restricted to
 * active projects, while client cash facts flow directly from saved contracts
 * and invoices without a separate finance activation step.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }

  const [viewPermission, policyPermission, editPermission] = await Promise.all([
    hasFinanceCapability(supabase, "finance.view_company"),
    hasFinanceCapability(supabase, "finance.manage_policy"),
    hasFinanceCapability(supabase, "finance.edit_forecast"),
  ]);
  if (viewPermission.error) {
    return NextResponse.json({ error: viewPermission.error }, { status: 500 });
  }
  if (!viewPermission.allowed) {
    return NextResponse.json({ error: "Company finance access denied" }, { status: 403 });
  }

  const asOfDate = request.nextUrl.searchParams.get("as_of_date") ??
    new Date().toISOString().slice(0, 10);
  const openingRaw = request.nextUrl.searchParams.get("opening_cash_minor");
  const openingCashMinor = openingRaw === null ? 0 : Number(openingRaw);
  if (!isIsoDate(asOfDate)) {
    return NextResponse.json({ error: "as_of_date must be an ISO calendar date" }, { status: 400 });
  }
  if (!Number.isSafeInteger(openingCashMinor)) {
    return NextResponse.json(
      { error: "opening_cash_minor must be a safe integer" },
      { status: 400 }
    );
  }

  const { data: rawProfiles, error: profileError } = await supabase
    .from("project_finance_profiles")
    .select(
      "project_id,finance_state,active_baseline_id,project:projects(id,name,job_number),active_baseline:forecast_baselines(id,effective_date,estimate_version_id,created_at)"
    )
    .order("updated_at", { ascending: false });
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  const profiles = (rawProfiles ?? []) as unknown as ProfileRow[];
  const activeProfiles = profiles.filter(
    (profile) => profile.finance_state === "active" && profile.active_baseline_id
  );
  const baselineIds = activeProfiles
    .map((profile) => profile.active_baseline_id)
    .filter((id): id is string => Boolean(id));

  let lines: ForecastLineRow[] = [];
  if (baselineIds.length > 0) {
    const { data, error } = await supabase
      .from("finance_forecast_lines")
      .select(
        "id,baseline_id,project_id,contribution_key,direction,source_type,source_record_id,source_version_id,description,dimension,planned_net_minor,committed_net_minor,actual_accrued_net_minor,actual_paid_net_minor,planned_date,committed_date,actual_due_date,actual_paid_date,confidence"
      )
      .in("baseline_id", baselineIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    lines = (data ?? []) as unknown as ForecastLineRow[];
  }

  const { data: rawRecurring, error: recurringError } = await supabase
    .from("finance_recurring_commitments")
    .select("*")
    .eq("status", "active")
    .order("first_due_date", { ascending: true });
  if (recurringError) {
    return NextResponse.json({ error: recurringError.message }, { status: 500 });
  }

  const { data: rawBillingProfiles, error: billingProfileError } = await supabase
    .from("client_billing_profiles")
    .select("*")
    .order("updated_at", { ascending: false });
  if (billingProfileError) {
    return NextResponse.json({ error: billingProfileError.message }, { status: 500 });
  }

  const billingProfiles = (rawBillingProfiles ?? []) as ClientBillingProfile[];
  const claimProjectIds = [...new Set(billingProfiles.map((profile) => profile.project_id))];
  const companyProjectIds = [...new Set([
    ...profiles.map((profile) => profile.project_id),
    ...claimProjectIds,
  ])];
  let paymentSchedule: ClientPaymentScheduleItem[] = [];
  let schedulePhases: ClientSchedulePhase[] = [];
  let clientInvoices: ClientInvoice[] = [];
  let companyProjects: ClaimProjectRow[] = [];
  let estimateVersions: EstimateVersionRow[] = [];
  let costSections: CostSectionForecastRow[] = [];
  if (companyProjectIds.length > 0) {
    const [
      scheduleResult,
      phaseResult,
      invoiceResult,
      projectResult,
      estimateResult,
      costSectionResult,
    ] = await Promise.all([
      supabase
        .from("client_payment_schedule")
        .select("*")
        .in("project_id", companyProjectIds)
        .is("deleted_at", null)
        .order("sort"),
      supabase
        .from("schedule_phases")
        .select("id,project_id,name,start_date,end_date,sort")
        .in("project_id", companyProjectIds)
        .is("deleted_at", null)
        .order("sort"),
      supabase
        .from("client_invoices")
        .select("*")
        .in("project_id", companyProjectIds)
        .is("deleted_at", null)
        .neq("status", "void"),
      supabase
        .from("projects")
        .select("id,name,job_number,project_stage")
        .in("id", companyProjectIds),
      supabase
        .from("estimate_versions")
        .select("id,project_id,snapshot,created_at")
        .in("project_id", companyProjectIds)
        .order("created_at", { ascending: false }),
      supabase
        .from("cost_sections")
        .select("id,project_id,forecast_phase_id")
        .in("project_id", companyProjectIds),
    ]);
    const companyReadError =
      scheduleResult.error ??
      phaseResult.error ??
      invoiceResult.error ??
      projectResult.error ??
      estimateResult.error ??
      costSectionResult.error;
    if (companyReadError) {
      return NextResponse.json({ error: companyReadError.message }, { status: 500 });
    }
    paymentSchedule = (scheduleResult.data ?? []) as ClientPaymentScheduleItem[];
    schedulePhases = (phaseResult.data ?? []) as ClientSchedulePhase[];
    clientInvoices = (invoiceResult.data ?? []) as ClientInvoice[];
    companyProjects = (projectResult.data ?? []) as ClaimProjectRow[];
    estimateVersions = (estimateResult.data ?? []) as unknown as EstimateVersionRow[];
    costSections = (costSectionResult.data ?? []) as CostSectionForecastRow[];
  }

  try {
    const projectNameById = new Map<string, string>();
    for (const profile of profiles) {
      projectNameById.set(profile.project_id, profile.project?.name ?? "Project");
    }
    for (const project of companyProjects) projectNameById.set(project.id, project.name);

    const sectionDatesByProjectId = new Map<string, Record<string, string>>();
    for (const projectId of companyProjectIds) {
      sectionDatesByProjectId.set(
        projectId,
        buildSectionForecastDates({
          sections: costSections.filter((section) => section.project_id === projectId),
          phases: schedulePhases.filter((phase) => phase.project_id === projectId),
        })
      );
    }

    const baselineProjectIds = new Set(activeProfiles.map((profile) => profile.project_id));
    const baselineContributions = lines.map((line) =>
      toContribution(
        line,
        projectNameById.get(line.project_id) ?? "Project",
        sectionDatesByProjectId.get(line.project_id) ?? {}
      )
    );
    const latestEstimateByProjectId = new Map<string, EstimateVersionRow>();
    for (const estimate of estimateVersions) {
      if (!latestEstimateByProjectId.has(estimate.project_id)) {
        latestEstimateByProjectId.set(estimate.project_id, estimate);
      }
    }
    const billingProfileByProjectId = new Map(
      billingProfiles.map((profile) => [profile.project_id, profile])
    );
    const companyProjectById = new Map(companyProjects.map((project) => [project.id, project]));
    const constructionCostProjectIds = new Set(
      companyProjects
        .filter((project) =>
          includesConstructionCosts(
            project.project_stage,
            billingProfileByProjectId.get(project.id)?.contract_type
          )
        )
        .map((project) => project.id)
    );
    const eligibleBaselineContributions = baselineContributions.filter((contribution) => {
      const projectId = contribution.sourceTrace?.project_id;
      return typeof projectId === "string" && constructionCostProjectIds.has(projectId);
    });
    const connectedEstimateContributions: FinanceContributionInput[] = [];
    for (const projectId of companyProjectIds) {
      if (!constructionCostProjectIds.has(projectId)) continue;
      if (baselineProjectIds.has(projectId)) continue;
      // Design-only projects contribute to client claims but not to cost outflows
      const projectFinanceState = profiles.find((p) => p.project_id === projectId)?.finance_state;
      if (projectFinanceState === "design_only") continue;
      const estimate = latestEstimateByProjectId.get(projectId);
      if (!estimate) continue;
      const projectName = projectNameById.get(projectId) ?? "Project";
      for (const contribution of buildEstimatePlanContributions({
        projectId,
        estimateVersionId: estimate.id,
        snapshot: estimate.snapshot,
        sectionDates: sectionDatesByProjectId.get(projectId) ?? {},
      })) {
        connectedEstimateContributions.push({
          ...contribution,
          sourceTrace: {
            ...(contribution.sourceTrace ?? {}),
            project_id: projectId,
            project_name: projectName,
          },
        });
      }
    }
    const projectContributions = [
      ...eligibleBaselineContributions,
      ...connectedEstimateContributions,
    ];
    const recurringCommitments = ((rawRecurring ?? []) as Record<string, unknown>[]).map(
      (row) => ({ ...row, amount_minor: safeMinor(row.amount_minor as number | string, `${String(row.id)}.amount`) }) as unknown as FinanceRecurringCommitment
    );
    const recurringContributions = generateRecurringContributions({
      commitments: recurringCommitments,
      asOfDate,
    });
    const clientClaimPortfolio = buildCompanyClientClaimPortfolio({
      profiles: billingProfiles,
      schedule: paymentSchedule,
      phases: schedulePhases,
      invoices: clientInvoices,
      projectNames: projectNameById,
    });
    const clientClaimContributions = clientClaimPortfolio.contributions;
    const contributions = [
      ...projectContributions,
      ...clientClaimContributions,
      ...recurringContributions,
    ];
    const shadowEnabled = financeShadowProjectionEnabled();
    const projection = shadowEnabled
      ? calculateShadowProjection({
          asOfDate,
          openingCashMinor,
          contributions,
        })
      : null;

    const costContributionsByProject = new Map<string, FinanceContributionInput[]>();
    for (const contribution of projectContributions) {
      const projectId =
        typeof contribution.sourceTrace?.project_id === "string"
          ? contribution.sourceTrace.project_id
          : null;
      if (!projectId || contribution.direction !== "outflow") continue;
      const existing = costContributionsByProject.get(projectId) ?? [];
      existing.push(contribution);
      costContributionsByProject.set(projectId, existing);
    }
    const profileByProjectId = new Map(profiles.map((profile) => [profile.project_id, profile]));
    const claimSummaryByProjectId = new Map(
      clientClaimPortfolio.projects.map((project) => [project.projectId, project])
    );
    const projects: FinanceCockpitProject[] = companyProjectIds.map((projectId) => {
      const profile = profileByProjectId.get(projectId);
      const companyProject = companyProjectById.get(projectId);
      const claimSummary = claimSummaryByProjectId.get(projectId);
      const projectCosts = costContributionsByProject.get(projectId) ?? [];
      const exposureMinor = projectCosts.reduce(
        (total, contribution) => total + effectiveContributionExposure(contribution),
        0
      );
      const unknownTimingMinor = projectCosts
        .filter((contribution) => !hasContributionDate(contribution))
        .reduce(
          (total, contribution) => total + effectiveContributionExposure(contribution),
          0
        );
      return {
        project_id: projectId,
        name: profile?.project?.name ?? companyProject?.name ?? "Unnamed project",
        job_number: profile?.project?.job_number ?? companyProject?.job_number ?? null,
        finance_state: profile?.finance_state ?? "candidate",
        baseline_id: profile?.active_baseline_id ?? null,
        baseline_effective_date: profile?.active_baseline?.effective_date ?? null,
        exposure_minor: exposureMinor,
        forecast_line_count: projectCosts.length,
        unknown_timing_minor: unknownTimingMinor,
        client_claim_count: claimSummary?.claimCount ?? 0,
        client_inflow_minor: claimSummary?.contractedMinor ?? 0,
        client_paid_minor: claimSummary?.paidMinor ?? 0,
      };
    });

    return NextResponse.json({
      mode: "shadow",
      persisted: false,
      shadow_enabled: shadowEnabled,
      can_manage_policy: !policyPermission.error && policyPermission.allowed,
      can_edit_forecast: !editPermission.error && editPermission.allowed,
      source_status: {
        xero: "not_configured",
        opening_cash: openingRaw === null ? "not_configured" : "request_preview",
        calculated_at: new Date().toISOString(),
      },
      counts: {
        active_projects: profiles.filter((profile) => profile.finance_state === "active").length,
        candidate_projects: profiles.filter((profile) =>
          ["candidate", "ready"].includes(profile.finance_state)
        ).length,
        design_only_projects: profiles.filter(
          (profile) => profile.finance_state === "design_only"
        ).length,
        active_recurring_commitments: recurringCommitments.length,
        connected_client_claims: clientClaimContributions.length,
        connected_projects: clientClaimPortfolio.summary.projectCount,
      },
      client_claims_summary: {
        contracted_minor: clientClaimPortfolio.summary.contractedMinor,
        issued_minor: clientClaimPortfolio.summary.issuedMinor,
        paid_minor: clientClaimPortfolio.summary.paidMinor,
        outstanding_minor: clientClaimPortfolio.summary.outstandingMinor,
        forecast_remaining_minor: clientClaimPortfolio.summary.forecastRemainingMinor,
      },
      recurring_summary: {
        projected_outflow_minor: recurringContributions.reduce(
          (sum, item) => sum + item.plannedMinor,
          0
        ),
        next_due_date: recurringContributions[0]?.plannedDate ?? null,
      },
      projects,
      projection,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not calculate finance cockpit" },
      { status: 422 }
    );
  }
}
