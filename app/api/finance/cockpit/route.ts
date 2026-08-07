import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import {
  financeFoundationEnabled,
  financeShadowProjectionEnabled,
} from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { calculateShadowProjection } from "@/lib/finance/projection";
import { buildClientClaimContributions } from "@/lib/finance/client-claims";
import { generateRecurringContributions } from "@/lib/finance/recurrence";
import { isIsoDate } from "@/lib/finance/readiness";
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

function safeMinor(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside safe minor-unit range`);
  }
  return parsed;
}

function effectiveExposure(line: ForecastLineRow): number {
  const planned = safeMinor(line.planned_net_minor, `${line.id}.planned`);
  const committed = safeMinor(line.committed_net_minor, `${line.id}.committed`);
  const accrued = safeMinor(line.actual_accrued_net_minor, `${line.id}.accrued`);
  return committed > 0 ? Math.max(committed, accrued) : Math.max(planned, accrued);
}

function toContribution(
  line: ForecastLineRow,
  projectName: string
): FinanceContributionInput {
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
    plannedDate: line.planned_date,
    committedDate: line.committed_date,
    actualDueDate: line.actual_due_date,
    actualPaidDate: line.actual_paid_date,
    baseEligible: true,
    confidence: line.confidence,
    sourceTrace: {
      project_id: line.project_id,
      project_name: projectName,
      forecast_line_id: line.id,
      source_type: line.source_type,
      source_record_id: line.source_record_id,
      source_version_id: line.source_version_id,
      dimension: line.dimension ?? {},
    },
  };
}

/**
 * M1/M4 bridge: a read-only company shadow cockpit. It uses only active,
 * immutable baselines and never persists or promotes the calculated result.
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

  const activeProjectIds = activeProfiles.map((profile) => profile.project_id);
  let billingProfiles: ClientBillingProfile[] = [];
  let paymentSchedule: ClientPaymentScheduleItem[] = [];
  let schedulePhases: ClientSchedulePhase[] = [];
  let clientInvoices: ClientInvoice[] = [];
  if (activeProjectIds.length > 0) {
    const [billingResult, scheduleResult, phaseResult, invoiceResult] = await Promise.all([
      supabase.from("client_billing_profiles").select("*").in("project_id", activeProjectIds),
      supabase
        .from("client_payment_schedule")
        .select("*")
        .in("project_id", activeProjectIds)
        .is("deleted_at", null)
        .order("sort"),
      supabase
        .from("schedule_phases")
        .select("id,project_id,name,start_date,end_date,sort")
        .in("project_id", activeProjectIds)
        .is("deleted_at", null)
        .order("sort"),
      supabase
        .from("client_invoices")
        .select("*")
        .in("project_id", activeProjectIds)
        .is("deleted_at", null)
        .neq("status", "void"),
    ]);
    const claimReadError = billingResult.error ?? scheduleResult.error ?? phaseResult.error ?? invoiceResult.error;
    if (claimReadError) {
      return NextResponse.json({ error: claimReadError.message }, { status: 500 });
    }
    billingProfiles = (billingResult.data ?? []) as ClientBillingProfile[];
    paymentSchedule = (scheduleResult.data ?? []) as ClientPaymentScheduleItem[];
    schedulePhases = (phaseResult.data ?? []) as ClientSchedulePhase[];
    clientInvoices = (invoiceResult.data ?? []) as ClientInvoice[];
  }

  try {
    const projectNameById = new Map(
      profiles.map((profile) => [profile.project_id, profile.project?.name ?? "Project"])
    );
    const projectContributions = lines.map((line) =>
      toContribution(line, projectNameById.get(line.project_id) ?? "Project")
    );
    const recurringCommitments = ((rawRecurring ?? []) as Record<string, unknown>[]).map(
      (row) => ({ ...row, amount_minor: safeMinor(row.amount_minor as number | string, `${String(row.id)}.amount`) }) as unknown as FinanceRecurringCommitment
    );
    const recurringContributions = generateRecurringContributions({
      commitments: recurringCommitments,
      asOfDate,
    });
    const clientClaimContributions = activeProjectIds.flatMap((projectId) =>
      buildClientClaimContributions({
        projectId,
        profile: billingProfiles.find((profile) => profile.project_id === projectId) ?? null,
        schedule: paymentSchedule.filter((stage) => stage.project_id === projectId),
        phases: schedulePhases.filter((phase) => phase.project_id === projectId),
        invoices: clientInvoices.filter((invoice) => invoice.project_id === projectId),
      })
    );
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

    const linesByProject = new Map<string, ForecastLineRow[]>();
    for (const line of lines) {
      const existing = linesByProject.get(line.project_id) ?? [];
      existing.push(line);
      linesByProject.set(line.project_id, existing);
    }
    const projects: FinanceCockpitProject[] = profiles.map((profile) => {
      const projectLines = linesByProject.get(profile.project_id) ?? [];
      const exposureMinor = projectLines.reduce(
        (total, line) => total + effectiveExposure(line),
        0
      );
      const unknownTimingMinor = projectLines
        .filter(
          (line) =>
            !line.planned_date &&
            !line.committed_date &&
            !line.actual_due_date &&
            !line.actual_paid_date
        )
        .reduce((total, line) => total + effectiveExposure(line), 0);
      return {
        project_id: profile.project_id,
        name: profile.project?.name ?? "Unnamed project",
        job_number: profile.project?.job_number ?? null,
        finance_state: profile.finance_state,
        baseline_id: profile.active_baseline_id,
        baseline_effective_date: profile.active_baseline?.effective_date ?? null,
        exposure_minor: exposureMinor,
        forecast_line_count: projectLines.length,
        unknown_timing_minor: unknownTimingMinor,
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
