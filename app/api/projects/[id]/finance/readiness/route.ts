import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { loadFinanceActivationReadiness } from "@/lib/finance/server-readiness";
import { createClient } from "@/lib/supabase/server";
import type { FinanceReadinessRequest } from "@/types/finance";

export const runtime = "nodejs";

/** Read-only readiness preview; POST is used because contract evidence is structured input. */
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

  let body: FinanceReadinessRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await loadFinanceActivationReadiness(supabase, projectId, body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ readiness: result.readiness });
}
