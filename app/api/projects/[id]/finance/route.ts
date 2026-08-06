import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Minimal M1 project-finance read model; no company cash aggregation. */
export async function GET(
  _request: NextRequest,
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
    "finance.view_project",
    projectId
  );
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) {
    return NextResponse.json({ error: "Project finance access denied" }, { status: 403 });
  }

  const [
    { data: project },
    { data: profile, error: profileError },
    { data: commercial, error: commercialError },
  ] = await Promise.all([
    supabase.from("projects").select("id,name,job_number,project_stage").eq("id", projectId).maybeSingle(),
    supabase
      .from("project_finance_profiles")
      .select("*,active_baseline:forecast_baselines(id,effective_date,estimate_version_id,program_watermark,content_hash,created_at)")
      .eq("project_id", projectId)
      .maybeSingle(),
    supabase
      .from("client_billing_profiles")
      .select("contract_type,contract_label,contract_amount_inc_gst,contract_reference,contract_signed_at,due_days")
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });
  if (commercialError) return NextResponse.json({ error: commercialError.message }, { status: 500 });
  if (!profile) {
    return NextResponse.json(
      { error: "Finance profile is unavailable. Apply migration 080." },
      { status: 503 }
    );
  }
  return NextResponse.json({
    project,
    finance: profile,
    commercial: commercial ? { ...commercial, project_stage: project.project_stage } : {
      project_stage: project.project_stage,
      contract_type: "design",
      contract_label: "Design package",
      contract_amount_inc_gst: 0,
      contract_reference: null,
      contract_signed_at: null,
      due_days: 14,
    },
  });
}
