import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { normalizeContractVariationInput } from "@/lib/contract-variation-packages";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function admin() {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { response: NextResponse.json({ error: "Only admins can edit contract variations" }, { status: 403 }) };
  return { supabase };
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; variationId: string }> }) {
  const { id: projectId, variationId } = await params;
  const auth = await admin();
  if ("response" in auth) return auth.response;
  const { supabase } = auth;
  const normalized = normalizeContractVariationInput(await request.json().catch(() => null));
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
  const input = normalized.value;

  const { data: existing, error: existingError } = await supabase.from("client_contract_variations").select("id").eq("id", variationId).eq("project_id", projectId).is("deleted_at", null).maybeSingle();
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Variation package not found" }, { status: 404 });

  const phaseIds = [...new Set(input.payment_schedule.map((row) => row.schedule_phase_id).filter((id): id is string => Boolean(id)))];
  if (phaseIds.length) {
    const { data, error } = await supabase.from("schedule_phases").select("id").eq("project_id", projectId).is("deleted_at", null).in("id", phaseIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if ((data ?? []).length !== phaseIds.length) return NextResponse.json({ error: "Every linked stage must belong to this project" }, { status: 400 });
  }
  const { error: updateError } = await supabase.from("client_contract_variations").update({
    label: input.label, amount_inc_gst: input.amount_inc_gst, due_days: input.due_days,
    reference: input.reference ?? null, approved_at: input.approved_at ?? null,
  }).eq("id", variationId).eq("project_id", projectId);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  const keepIds: string[] = [];
  for (const row of input.payment_schedule) {
    const values = {
      label: row.label, percentage: row.percentage ?? null, amount_inc_gst: row.amount_inc_gst,
      milestone_date: row.trigger_type === "manual" ? row.milestone_date ?? null : null,
      trigger_type: row.trigger_type,
      schedule_phase_id: row.trigger_type === "schedule_phase" ? row.schedule_phase_id ?? null : null,
      sort: row.sort,
    };
    if (row.id) {
      const { data, error } = await supabase.from("client_payment_schedule").update(values).eq("id", row.id).eq("project_id", projectId).eq("contract_variation_id", variationId).is("client_invoice_id", null).select("id").maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: "A variation stage could not be edited because it is issued or no longer exists" }, { status: 409 });
      keepIds.push(data.id);
    } else {
      const { data, error } = await supabase.from("client_payment_schedule").insert({ ...values, project_id: projectId, contract_variation_id: variationId }).select("id").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      keepIds.push(data.id);
    }
  }
  let remove = supabase.from("client_payment_schedule").update({ deleted_at: new Date().toISOString() }).eq("project_id", projectId).eq("contract_variation_id", variationId).is("client_invoice_id", null).is("deleted_at", null);
  if (keepIds.length) remove = remove.not("id", "in", `(${keepIds.join(",")})`);
  const { error: removeError } = await remove;
  if (removeError) return NextResponse.json({ error: removeError.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; variationId: string }> }) {
  const { id: projectId, variationId } = await params;
  const auth = await admin();
  if ("response" in auth) return auth.response;
  const { supabase } = auth;
  const { count, error: countError } = await supabase.from("client_payment_schedule").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("contract_variation_id", variationId).not("client_invoice_id", "is", null).is("deleted_at", null);
  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });
  if ((count ?? 0) > 0) return NextResponse.json({ error: "This variation has issued claims and cannot be deleted" }, { status: 409 });
  const now = new Date().toISOString();
  const { error: scheduleError } = await supabase.from("client_payment_schedule").update({ deleted_at: now }).eq("project_id", projectId).eq("contract_variation_id", variationId).is("deleted_at", null);
  if (scheduleError) return NextResponse.json({ error: scheduleError.message }, { status: 500 });
  const { error } = await supabase.from("client_contract_variations").update({ deleted_at: now }).eq("id", variationId).eq("project_id", projectId).is("deleted_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
