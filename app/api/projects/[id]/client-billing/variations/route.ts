import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { normalizeContractVariationInput } from "@/lib/contract-variation-packages";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Only admins can add contract variations" }, { status: 403 });

  const normalized = normalizeContractVariationInput(await request.json().catch(() => null));
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
  const input = normalized.value;
  const { data: baseContract, error: baseError } = await supabase.from("client_billing_profiles").select("project_id").eq("project_id", projectId).maybeSingle();
  if (baseError) return NextResponse.json({ error: baseError.message }, { status: 500 });
  if (!baseContract) return NextResponse.json({ error: "Set the original contract and payment schedule before adding a variation" }, { status: 409 });
  const phaseIds = [...new Set(input.payment_schedule.map((row) => row.schedule_phase_id).filter((id): id is string => Boolean(id)))];
  if (phaseIds.length) {
    const { data, error } = await supabase.from("schedule_phases").select("id").eq("project_id", projectId).is("deleted_at", null).in("id", phaseIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if ((data ?? []).length !== phaseIds.length) return NextResponse.json({ error: "Every linked stage must belong to this project" }, { status: 400 });
  }

  const { data: variation, error: variationError } = await supabase.from("client_contract_variations").insert({
    project_id: projectId,
    label: input.label,
    amount_inc_gst: input.amount_inc_gst,
    due_days: input.due_days,
    reference: input.reference ?? null,
    approved_at: input.approved_at ?? null,
  }).select().single();
  if (variationError) return NextResponse.json({ error: variationError.message }, { status: 500 });

  const rows = input.payment_schedule.map((row) => ({
    project_id: projectId,
    contract_variation_id: variation.id,
    label: row.label,
    percentage: row.percentage ?? null,
    amount_inc_gst: row.amount_inc_gst,
    milestone_date: row.trigger_type === "manual" ? row.milestone_date ?? null : null,
    trigger_type: row.trigger_type,
    schedule_phase_id: row.trigger_type === "schedule_phase" ? row.schedule_phase_id ?? null : null,
    sort: row.sort,
  }));
  const { error: scheduleError } = await supabase.from("client_payment_schedule").insert(rows);
  if (scheduleError) {
    await supabase.from("client_contract_variations").delete().eq("id", variation.id);
    return NextResponse.json({ error: scheduleError.message }, { status: 500 });
  }
  return NextResponse.json({ variation }, { status: 201 });
}
