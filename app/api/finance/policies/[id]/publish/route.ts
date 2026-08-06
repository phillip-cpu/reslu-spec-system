import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { isIsoDate } from "@/lib/finance/readiness";
import { createClient } from "@/lib/supabase/server";
import type { PublishFinancePolicyRequest } from "@/types/finance";

export const runtime = "nodejs";

/**
 * Publishes the M0 policy only after explicit owner, accountant and legal
 * confirmations. The database function performs the same checks under lock.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: policyId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }

  const permission = await hasFinanceCapability(supabase, "finance.manage_policy");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) {
    return NextResponse.json({ error: "Finance policy access denied" }, { status: 403 });
  }

  let body: PublishFinancePolicyRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isIsoDate(body.effective_from) || !body.reason?.trim()) {
    return NextResponse.json(
      { error: "effective_from and reason are required" },
      { status: 400 }
    );
  }
  if (
    !body.configuration ||
    typeof body.configuration !== "object" ||
    Array.isArray(body.configuration) ||
    !body.confirmations ||
    typeof body.confirmations !== "object" ||
    Array.isArray(body.confirmations)
  ) {
    return NextResponse.json(
      { error: "configuration and confirmations must be objects" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.rpc("publish_finance_policy", {
    p_policy_id: policyId,
    p_effective_from: body.effective_from,
    p_configuration: body.configuration,
    p_confirmations: body.confirmations,
    p_reason: body.reason.trim(),
  });
  if (error) {
    const conflict = /confirmation|draft|incomplete|invalid|required/i.test(error.message);
    return NextResponse.json(
      { error: error.message },
      { status: conflict ? 409 : 500 }
    );
  }
  return NextResponse.json({ policy: data });
}
