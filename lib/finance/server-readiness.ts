import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FinanceActivationReadiness,
  FinancePolicyVersion,
  FinanceReadinessRequest,
  ProjectFinanceProfile,
} from "../../types/finance";
import { evaluateFinanceActivationReadiness, isIsoDate } from "./readiness";

export type LoadFinanceReadinessResult =
  | { readiness: FinanceActivationReadiness }
  | { error: string; status: number };

export async function loadFinanceActivationReadiness(
  supabase: SupabaseClient,
  projectId: string,
  request: FinanceReadinessRequest
): Promise<LoadFinanceReadinessResult> {
  const effectiveDate = request.effective_date;
  if (!isIsoDate(effectiveDate)) {
    return { error: "effective_date must be an ISO calendar date", status: 400 };
  }

  const [{ data: project, error: projectError }, { data: profile, error: profileError }] =
    await Promise.all([
      supabase.from("projects").select("id").eq("id", projectId).maybeSingle(),
      supabase
        .from("project_finance_profiles")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle(),
    ]);

  if (projectError || !project) return { error: "Project not found", status: 404 };
  if (profileError) return { error: profileError.message, status: 500 };
  if (!profile) {
    return {
      error: "Finance profile is unavailable. Apply migration 080 before enabling finance.",
      status: 503,
    };
  }

  let estimateQuery = supabase
    .from("estimate_versions")
    .select("id,label")
    .eq("project_id", projectId);
  estimateQuery = request.estimate_version_id
    ? estimateQuery.eq("id", request.estimate_version_id)
    : estimateQuery.order("created_at", { ascending: false }).limit(1);

  let policyQuery = supabase.from("finance_policy_versions").select("*");
  policyQuery = request.policy_version_id
    ? policyQuery.eq("id", request.policy_version_id)
    : policyQuery
        .eq("policy_key", "company")
        .eq("status", "published")
        .lte("effective_from", effectiveDate)
        .order("effective_from", { ascending: false })
        .order("version_number", { ascending: false })
        .limit(1);

  const [
    { data: estimateRows, error: estimateError },
    { data: policyRows, error: policyError },
    { count: programPhaseCount, error: programError },
    { data: programWatermark, error: watermarkError },
  ] = await Promise.all([
    estimateQuery,
    policyQuery,
    supabase
      .from("schedule_phases")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase.rpc("finance_program_watermark", { p_project_id: projectId }),
  ]);

  const readError = estimateError ?? policyError ?? programError ?? watermarkError;
  if (readError) return { error: readError.message, status: 500 };

  const estimate = estimateRows?.[0] ?? null;
  const policy = (policyRows?.[0] as FinancePolicyVersion | undefined) ?? null;
  return {
    readiness: evaluateFinanceActivationReadiness({
      projectId,
      profile: profile as ProjectFinanceProfile,
      contractEvidence: request.contract_evidence,
      estimateVersion: estimate ? { id: estimate.id, label: estimate.label } : null,
      programWatermark:
        (programPhaseCount ?? 0) > 0 && typeof programWatermark === "string"
          ? programWatermark
          : null,
      programPhaseCount: programPhaseCount ?? 0,
      policyVersion: policy,
      effectiveDate,
    }),
  };
}
