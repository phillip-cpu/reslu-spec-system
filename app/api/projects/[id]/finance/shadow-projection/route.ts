import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { buildEstimatePlanContributions } from "@/lib/finance/baseline";
import {
  financeShadowProjectionEnabled,
} from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { calculateShadowProjection } from "@/lib/finance/projection";
import { isIsoDate } from "@/lib/finance/readiness";
import { createClient } from "@/lib/supabase/server";
import type { FinanceShadowProjectionRequest, ProjectFinanceProfile } from "@/types/finance";
import type { FinanceEstimateSnapshot } from "@/lib/finance/baseline";

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
  ] = await Promise.all([
    supabase.from("projects").select("id").eq("id", projectId).maybeSingle(),
    supabase
      .from("project_finance_profiles")
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle(),
    estimateQuery,
  ]);

  if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const readError = profileError ?? estimateError;
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!profile) {
    return NextResponse.json(
      { error: "Finance profile is unavailable. Apply migration 080." },
      { status: 503 }
    );
  }
  const estimate = estimateRows?.[0];
  if (!estimate) {
    return NextResponse.json(
      { error: "Save an estimate version before running a shadow projection" },
      { status: 409 }
    );
  }

  try {
    const contributions = buildEstimatePlanContributions({
      projectId,
      estimateVersionId: estimate.id,
      snapshot: estimate.snapshot as FinanceEstimateSnapshot,
      timingOverrides,
    });
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
        estimate_version_id: estimate.id,
        estimate_label: estimate.label,
        timing_override_count: Object.keys(timingOverrides).length,
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
