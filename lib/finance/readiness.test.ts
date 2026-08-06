import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFinanceActivationReadiness } from "./readiness.ts";
import type { FinancePolicyVersion, ProjectFinanceProfile } from "../../types/finance.ts";

const profile: ProjectFinanceProfile = {
  project_id: "project-1",
  finance_state: "candidate",
  policy_version_id: null,
  active_baseline_id: null,
  current_projection_id: null,
  activated_at: null,
  activated_by: null,
  version: 1,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

const policy: FinancePolicyVersion = {
  id: "policy-1",
  policy_key: "company",
  version_number: 2,
  status: "published",
  effective_from: "2026-08-01",
  configuration: {},
  confirmations: {},
  note: null,
  created_by: "owner",
  approved_by: "owner",
  created_at: "2026-08-01T00:00:00Z",
  approved_at: "2026-08-01T00:00:00Z",
};

test("activation is ready only when all five evidence gates are current", () => {
  const result = evaluateFinanceActivationReadiness({
    projectId: "project-1",
    profile,
    contractEvidence: {
      reference: "Contract 026",
      signed_at: "2026-08-05",
      document_id: "doc-1",
    },
    estimateVersion: { id: "estimate-1", label: "V7" },
    programWatermark: "watermark",
    programPhaseCount: 4,
    policyVersion: policy,
    effectiveDate: "2026-08-10",
  });
  assert.equal(result.ready, true);
  assert.ok(result.checks.every((check) => check.ready));
});

test("draft policy, missing contract and active lifecycle fail closed", () => {
  const result = evaluateFinanceActivationReadiness({
    projectId: "project-1",
    profile: { ...profile, finance_state: "active" },
    contractEvidence: null,
    estimateVersion: { id: "estimate-1", label: "V7" },
    programWatermark: "watermark",
    programPhaseCount: 4,
    policyVersion: { ...policy, status: "draft", approved_at: null, approved_by: null },
    effectiveDate: "2026-08-10",
  });
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.checks.filter((check) => !check.ready).map((check) => check.code),
    ["signed_contract", "published_policy", "lifecycle_state"]
  );
});

test("a future policy is not effective for an earlier activation", () => {
  const result = evaluateFinanceActivationReadiness({
    projectId: "project-1",
    profile,
    contractEvidence: { reference: "Contract", signed_at: "2026-08-05" },
    estimateVersion: { id: "estimate-1", label: "V7" },
    programWatermark: "watermark",
    programPhaseCount: 1,
    policyVersion: { ...policy, effective_from: "2026-09-01" },
    effectiveDate: "2026-08-10",
  });
  assert.equal(result.checks.find((check) => check.code === "published_policy")?.ready, false);
});
