import type {
  ClientPaymentTriggerType,
  SaveContractVariationInput,
} from "@/types/client-invoices";

const TRIGGER_TYPES = new Set<ClientPaymentTriggerType>([
  "contract_signed",
  "schedule_phase",
  "manual",
]);

export function normalizeContractVariationInput(raw: unknown):
  | { ok: true; value: SaveContractVariationInput }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid variation package" };
  const body = raw as Partial<SaveContractVariationInput>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const amount = Number(body.amount_inc_gst);
  const dueDays = Math.max(0, Math.trunc(Number(body.due_days)));
  const approvedAt = typeof body.approved_at === "string" && body.approved_at ? body.approved_at : null;
  const reference = typeof body.reference === "string" && body.reference.trim() ? body.reference.trim() : null;
  if (!label || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(dueDays)) {
    return { ok: false, error: "Enter a variation name, positive value and valid payment terms" };
  }
  const schedule = Array.isArray(body.payment_schedule)
    ? body.payment_schedule.map((row, index) => ({
        id: typeof row.id === "string" && row.id ? row.id : undefined,
        label: typeof row.label === "string" ? row.label.trim() : "",
        percentage: row.percentage == null ? null : Number(row.percentage),
        amount_inc_gst: Number(row.amount_inc_gst),
        milestone_date: typeof row.milestone_date === "string" && row.milestone_date ? row.milestone_date : null,
        trigger_type: TRIGGER_TYPES.has(row.trigger_type) ? row.trigger_type : "manual" as const,
        schedule_phase_id: typeof row.schedule_phase_id === "string" && row.schedule_phase_id ? row.schedule_phase_id : null,
        sort: index,
      }))
    : [];
  if (
    schedule.length === 0 ||
    schedule.some((row) =>
      !row.label || !Number.isFinite(row.amount_inc_gst) || row.amount_inc_gst < 0 ||
      (row.percentage !== null && !Number.isFinite(row.percentage)) ||
      (row.trigger_type === "schedule_phase" && !row.schedule_phase_id)
    )
  ) {
    return { ok: false, error: "Add at least one valid variation payment stage" };
  }
  const scheduleTotal = Math.round(schedule.reduce((sum, row) => sum + row.amount_inc_gst, 0) * 100) / 100;
  if (Math.abs(scheduleTotal - amount) > 0.01) {
    return { ok: false, error: "The variation payment schedule must equal the variation value" };
  }
  return {
    ok: true,
    value: { label, amount_inc_gst: amount, due_days: dueDays, reference, approved_at: approvedAt, payment_schedule: schedule },
  };
}
