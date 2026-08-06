import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }
  const permission = await hasFinanceCapability(supabase, "finance.edit_forecast");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) {
    return NextResponse.json({ error: "Recurring commitment edit denied" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json()) as { expected_version?: number; reason?: string };
  if (!Number.isInteger(body.expected_version) || !body.reason?.trim()) {
    return NextResponse.json(
      { error: "Expected version and archive reason are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.rpc("archive_finance_recurring_commitment", {
    p_id: id,
    p_expected_version: body.expected_version,
    p_reason: body.reason,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ commitment: data });
}
