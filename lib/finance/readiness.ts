import type {
  FinanceActivationReadiness,
  FinancePolicyVersion,
  ProjectFinanceProfile,
  SignedContractEvidence,
} from "../../types/finance";

export interface FinanceReadinessFacts {
  projectId: string;
  profile: ProjectFinanceProfile;
  contractEvidence?: Partial<SignedContractEvidence> | null;
  estimateVersion: { id: string; label: string } | null;
  programWatermark: string | null;
  programPhaseCount: number;
  policyVersion: FinancePolicyVersion | null;
  effectiveDate: string;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function hasSignedContractEvidence(
  evidence: Partial<SignedContractEvidence> | null | undefined
): boolean {
  return Boolean(
    evidence?.reference?.trim() &&
      isIsoDate(evidence.signed_at) &&
      (evidence.document_id?.trim() ||
        evidence.storage_path?.trim() ||
        evidence.reference.trim())
  );
}

export function evaluateFinanceActivationReadiness(
  facts: FinanceReadinessFacts
): FinanceActivationReadiness {
  const policyEffective = Boolean(
    facts.policyVersion &&
      facts.policyVersion.status === "published" &&
      isIsoDate(facts.effectiveDate) &&
      facts.policyVersion.effective_from <= facts.effectiveDate
  );
  const lifecycleReady = new Set(["design_only", "candidate", "ready"]).has(
    facts.profile.finance_state
  );
  const checks = [
    {
      code: "signed_contract" as const,
      ready: hasSignedContractEvidence(facts.contractEvidence),
      message: "Signed contract evidence includes a reference and signed date.",
    },
    {
      code: "saved_estimate" as const,
      ready: Boolean(facts.estimateVersion),
      message: "A saved immutable estimate version is selected.",
    },
    {
      code: "dated_program" as const,
      ready: facts.programPhaseCount > 0 && Boolean(facts.programWatermark),
      message: "The project has at least one current dated program phase.",
    },
    {
      code: "published_policy" as const,
      ready: policyEffective,
      message: "An approved published finance policy is effective on activation.",
    },
    {
      code: "lifecycle_state" as const,
      ready: lifecycleReady,
      message: "The project finance lifecycle permits activation.",
    },
  ];

  return {
    ready: checks.every((check) => check.ready),
    checks,
    project_id: facts.projectId,
    finance_state: facts.profile.finance_state,
    profile_version: facts.profile.version,
    estimate_version_id: facts.estimateVersion?.id ?? null,
    estimate_label: facts.estimateVersion?.label ?? null,
    policy_version_id: facts.policyVersion?.id ?? null,
    program_watermark: facts.programWatermark,
    program_phase_count: facts.programPhaseCount,
  };
}
