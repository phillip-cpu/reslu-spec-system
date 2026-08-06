import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { loadFinanceActivationReadiness } from "@/lib/finance/server-readiness";
import { createClient } from "@/lib/supabase/server";
import type { ActivateProjectFinanceRequest } from "@/types/finance";

export const runtime = "nodejs";

/** Atomic activation. Database function revalidates every preview fact under lock. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }

  const permission = await hasFinanceCapability(
    supabase,
    "finance.activate_project",
    projectId
  );
  if (permission.error) {
    return NextResponse.json({ error: permission.error }, { status: 500 });
  }
  if (!permission.allowed) {
    return NextResponse.json({ error: "Finance activation access denied" }, { status: 403 });
  }

  let body: ActivateProjectFinanceRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.reason?.trim() || !body.idempotency_key?.trim()) {
    return NextResponse.json(
      { error: "reason and idempotency_key are required" },
      { status: 400 }
    );
  }
  if (!Number.isInteger(body.expected_profile_version) || body.expected_profile_version <= 0) {
    return NextResponse.json(
      { error: "expected_profile_version must be a positive integer" },
      { status: 400 }
    );
  }

  const readinessResult = await loadFinanceActivationReadiness(supabase, projectId, body);
  if ("error" in readinessResult) {
    return NextResponse.json(
      { error: readinessResult.error },
      { status: readinessResult.status }
    );
  }
  const readiness = readinessResult.readiness;
  if (!readiness.ready) {
    return NextResponse.json(
      { error: "Finance activation prerequisites are incomplete", readiness },
      { status: 409 }
    );
  }
  if (
    body.expected_profile_version !== readiness.profile_version ||
    body.program_watermark !== readiness.program_watermark
  ) {
    return NextResponse.json(
      { error: "Finance readiness changed; preview again before activation", readiness },
      { status: 409 }
    );
  }

  const { data, error } = await supabase.rpc("activate_project_finance", {
    p_project_id: projectId,
    p_effective_date: body.effective_date,
    p_estimate_version_id: body.estimate_version_id,
    p_program_watermark: body.program_watermark,
    p_policy_version_id: body.policy_version_id,
    p_contract_evidence: body.contract_evidence,
    p_reason: body.reason.trim(),
    p_idempotency_key: body.idempotency_key.trim(),
    p_expected_profile_version: body.expected_profile_version,
  });
  if (error) {
    const conflict = /changed|cannot activate|policy|program|evidence|required/i.test(
      error.message
    );
    return NextResponse.json(
      { error: error.message },
      { status: conflict ? 409 : 500 }
    );
  }

  const activation = Array.isArray(data) ? data[0] ?? null : data;
  return NextResponse.json({ activation }, { status: 201 });
}
