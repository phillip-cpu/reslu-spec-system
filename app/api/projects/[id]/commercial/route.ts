import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { isIsoDate } from "@/lib/finance/readiness";
import { createClient } from "@/lib/supabase/server";
import {
  PROJECT_STAGES,
  type SaveProjectCommercialProfileRequest,
} from "@/types/finance";

export const runtime = "nodejs";

const CONTRACT_TYPES = new Set(["design", "construction", "other"]);

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit project commercial details" }, { status: 403 });
  }

  let body: SaveProjectCommercialProfileRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!PROJECT_STAGES.includes(body.project_stage)) {
    return NextResponse.json({ error: "Choose a valid project stage" }, { status: 400 });
  }
  if (!CONTRACT_TYPES.has(body.contract_type)) {
    return NextResponse.json({ error: "Choose a valid contract type" }, { status: 400 });
  }
  const contractLabel = typeof body.contract_label === "string" ? body.contract_label.trim() : "";
  const contractReference = typeof body.contract_reference === "string" ? body.contract_reference.trim() : "";
  const contractAmount = Number(body.contract_amount_inc_gst);
  const dueDays = Math.max(0, Math.trunc(Number(body.due_days)));
  const signedAt = body.contract_signed_at || null;
  if (!contractLabel || !Number.isFinite(contractAmount) || contractAmount < 0) {
    return NextResponse.json({ error: "Enter a contract name and valid amount" }, { status: 400 });
  }
  if (!Number.isFinite(dueDays)) {
    return NextResponse.json({ error: "Payment terms must be a valid number of days" }, { status: 400 });
  }
  if (signedAt && !isIsoDate(signedAt)) {
    return NextResponse.json({ error: "Signed date must be a valid calendar date" }, { status: 400 });
  }
  if (signedAt && !contractReference) {
    return NextResponse.json({ error: "Add the agreement reference for a signed contract" }, { status: 400 });
  }

  // Commercial setup reads the shared stage but never writes it. All stage
  // changes go through PATCH /api/projects/[id]/stage and its closeout gates.
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { error: billingError } = await supabase.from("client_billing_profiles").upsert({
    project_id: projectId,
    contract_type: body.contract_type,
    contract_label: contractLabel,
    contract_amount_inc_gst: contractAmount,
    contract_reference: contractReference || null,
    contract_signed_at: signedAt,
    due_days: dueDays,
  });
  if (billingError) return NextResponse.json({ error: billingError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
