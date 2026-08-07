import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type {
  ClientContractType,
  ClientPaymentTriggerType,
  SaveClientBillingInput,
} from "@/types/client-invoices";

export const runtime = "nodejs";

const CONTRACT_TYPES: ClientContractType[] = ["design", "construction", "other"];
const TRIGGER_TYPES: ClientPaymentTriggerType[] = ["contract_signed", "schedule_phase", "manual"];

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit client billing" }, { status: 403 });
  }

  let body: SaveClientBillingInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contractType = CONTRACT_TYPES.includes(body.contract_type) ? body.contract_type : null;
  const contractLabel = typeof body.contract_label === "string" ? body.contract_label.trim() : "";
  const contractAmount = Number(body.contract_amount_inc_gst);
  const dueDays = Math.max(0, Math.trunc(Number(body.due_days)));
  if (!contractType || !contractLabel || !Number.isFinite(contractAmount) || contractAmount < 0) {
    return NextResponse.json({ error: "Complete the contract type, label and amount" }, { status: 400 });
  }
  if (!Number.isFinite(dueDays)) {
    return NextResponse.json({ error: "Payment terms must be a valid number of days" }, { status: 400 });
  }

  const schedule = Array.isArray(body.payment_schedule)
    ? body.payment_schedule.map((row, index) => ({
        id: typeof row.id === "string" && row.id ? row.id : undefined,
        label: typeof row.label === "string" ? row.label.trim() : "",
        percentage:
          row.percentage === null || row.percentage === undefined
            ? null
            : Number(row.percentage),
        amount_inc_gst: Number(row.amount_inc_gst),
        milestone_date:
          typeof row.milestone_date === "string" && row.milestone_date ? row.milestone_date : null,
        trigger_type: TRIGGER_TYPES.includes(row.trigger_type) ? row.trigger_type : "manual",
        schedule_phase_id:
          typeof row.schedule_phase_id === "string" && row.schedule_phase_id
            ? row.schedule_phase_id
            : null,
        sort: index,
      }))
    : [];

  if (
    schedule.length === 0 ||
    schedule.some(
      (row) =>
        !row.label ||
        !Number.isFinite(row.amount_inc_gst) ||
        row.amount_inc_gst < 0 ||
        (row.percentage !== null && !Number.isFinite(row.percentage)) ||
        (row.trigger_type === "schedule_phase" && !row.schedule_phase_id)
    )
  ) {
    return NextResponse.json(
      { error: "Add at least one valid package payment stage" },
      { status: 400 }
    );
  }

  const scheduleTotal = Math.round(schedule.reduce((sum, row) => sum + row.amount_inc_gst, 0) * 100) / 100;
  if (Math.abs(scheduleTotal - contractAmount) > 0.01) {
    return NextResponse.json(
      { error: "The payment schedule must equal the original contract amount" },
      { status: 400 }
    );
  }

  const selectedPhaseIds = [
    ...new Set(
      schedule
        .filter((row) => row.trigger_type === "schedule_phase")
        .map((row) => row.schedule_phase_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  if (selectedPhaseIds.length > 0) {
    const { data: phases, error: phaseError } = await supabase
      .from("schedule_phases")
      .select("id")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .in("id", selectedPhaseIds);
    if (phaseError) return NextResponse.json({ error: phaseError.message }, { status: 500 });
    if ((phases ?? []).length !== selectedPhaseIds.length) {
      return NextResponse.json(
        { error: "Every linked construction stage must belong to this project" },
        { status: 400 }
      );
    }
  }

  const { error: profileError } = await supabase.from("client_billing_profiles").upsert({
    project_id: projectId,
    contract_type: contractType,
    contract_label: contractLabel,
    contract_amount_inc_gst: contractAmount,
    due_days: dueDays,
  });
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  const keepIds: string[] = [];
  for (const row of schedule) {
    if (row.id) {
      const { data, error } = await supabase
        .from("client_payment_schedule")
        .update({
          label: row.label,
          percentage: row.percentage,
          amount_inc_gst: row.amount_inc_gst,
          milestone_date: row.trigger_type === "manual" ? row.milestone_date : null,
          trigger_type: row.trigger_type,
          schedule_phase_id:
            row.trigger_type === "schedule_phase" ? row.schedule_phase_id : null,
          sort: row.sort,
        })
        .eq("id", row.id)
        .eq("project_id", projectId)
        .is("client_invoice_id", null)
        .select("id")
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.id) keepIds.push(data.id);
      else keepIds.push(row.id);
    } else {
      const { data, error } = await supabase
        .from("client_payment_schedule")
        .insert({
          project_id: projectId,
          label: row.label,
          percentage: row.percentage,
          amount_inc_gst: row.amount_inc_gst,
          milestone_date: row.trigger_type === "manual" ? row.milestone_date : null,
          trigger_type: row.trigger_type,
          schedule_phase_id:
            row.trigger_type === "schedule_phase" ? row.schedule_phase_id : null,
          sort: row.sort,
        })
        .select("id")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      keepIds.push(data.id);
    }
  }

  let removable = supabase
    .from("client_payment_schedule")
    .update({ deleted_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .is("client_invoice_id", null)
    .is("deleted_at", null);
  if (keepIds.length) removable = removable.not("id", "in", `(${keepIds.join(",")})`);
  const { error: removeError } = await removable;
  if (removeError) return NextResponse.json({ error: removeError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
