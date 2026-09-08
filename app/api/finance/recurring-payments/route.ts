import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { generateRecurringOccurrences, normalizeRecurringPayment } from "@/lib/finance/recurrence";
import { buildWeeklyPeriods } from "@/lib/finance/projection";
import { isIsoDate } from "@/lib/finance/readiness";
import { createClient } from "@/lib/supabase/server";
import type { FinanceRecurringCommitment } from "@/types/finance";

export const runtime = "nodejs";

async function authorize(edit: boolean) {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!financeFoundationEnabled()) return { response: NextResponse.json({ error: "Finance is not enabled" }, { status: 404 }) };
  const [view, write] = await Promise.all([
    hasFinanceCapability(supabase, "finance.view_company"),
    hasFinanceCapability(supabase, "finance.edit_forecast"),
  ]);
  if (view.error || write.error) return { response: NextResponse.json({ error: view.error || write.error }, { status: 500 }) };
  if (edit ? !write.allowed : !view.allowed && !write.allowed) {
    return { response: NextResponse.json({ error: "Finance access denied" }, { status: 403 }) };
  }
  return { supabase, canEdit: write.allowed };
}

export async function GET(request: NextRequest) {
  const auth = await authorize(false);
  if (auth.response) return auth.response;
  const asOfDate = request.nextUrl.searchParams.get("as_of_date") ?? new Date().toISOString().slice(0, 10);
  if (!isIsoDate(asOfDate)) return NextResponse.json({ error: "as_of_date must be a calendar date" }, { status: 400 });
  const [commitmentResult, paymentResult, invoiceResult] = await Promise.all([
    auth.supabase.from("finance_recurring_commitments").select("*").order("first_due_date"),
    auth.supabase.from("finance_recurring_occurrence_payments").select("*", { count: "exact" }).order("due_date").limit(1000),
    auth.supabase.from("invoices")
      .select("id,recurring_commitment_id,recurring_due_date,currency_code", { count: "exact" })
      .eq("status", "approved").not("recurring_due_date", "is", null).limit(1000),
  ]);
  const error = commitmentResult.error || paymentResult.error || invoiceResult.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if ((paymentResult.count ?? 0) > (paymentResult.data?.length ?? 0) ||
      (invoiceResult.count ?? 0) > (invoiceResult.data?.length ?? 0)) {
    return NextResponse.json({ error: "Recurring payment history exceeds the safe loading limit; no partial totals have been shown." }, { status: 422 });
  }
  try {
    const commitments = (commitmentResult.data ?? []).map((row) => {
      const amount = Number(row.amount_minor);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid recurring amount");
      return { ...row, amount_minor: amount } as FinanceRecurringCommitment;
    });
    const payments = (paymentResult.data ?? []).map(normalizeRecurringPayment);
    const linked = new Map((invoiceResult.data ?? []).map((invoice) => [
      `${invoice.recurring_commitment_id}:${invoice.recurring_due_date}`, invoice,
    ]));
    const horizonEnd = buildWeeklyPeriods(asOfDate, 13).at(-1)!.endsOn;
    const occurrences = generateRecurringOccurrences({ commitments, payments, asOfDate })
      .filter((item) => item.due_date <= horizonEnd).map((item) => {
      const invoice = linked.get(`${item.commitment_id}:${item.due_date}`);
      // The cockpit reconciles bank/Xero and bill-ledger evidence. Do not present a
      // second, local-only payment total here for an occurrence managed by a bill.
      return { ...item,
        linked_invoice_id: invoice?.id ?? null,
        commitment_version: commitments.find((commitment) => commitment.id === item.commitment_id)!.version,
      };
    });
    return NextResponse.json({
      commitments: commitments.filter((item) => item.status !== "archived"),
      payments, occurrences, can_edit: auth.canEdit, as_of_date: asOfDate,
      summary: {
        active_count: commitments.filter((item) => item.status === "active").length,
        projected_outflow_minor: occurrences.filter((item) => !item.linked_invoice_id).reduce((sum, item) => sum + item.remaining_minor, 0),
        next_due_date: occurrences.find((item) => !item.linked_invoice_id && item.remaining_minor > 0)?.due_date ?? null,
        linked_occurrence_count: occurrences.filter((item) => item.linked_invoice_id).length,
      },
    });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Could not read payment history" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorize(true);
  if (auth.response) return auth.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "A payment record is required" }, { status: 400 });
  }
  if (!body || typeof body !== "object" ||
      typeof body.commitment_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.commitment_id) ||
      !isIsoDate(body.due_date) || !isIsoDate(body.paid_on) ||
      !Number.isSafeInteger(body.amount_minor) || Number(body.amount_minor) <= 0 ||
      !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 0 ||
      !Number.isSafeInteger(body.expected_commitment_version) || Number(body.expected_commitment_version) < 1 ||
      typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "Select an occurrence and enter its payment amount, actual date and reference." }, { status: 400 });
  }
  const { data, error } = await auth.supabase.rpc("record_finance_recurring_payment", {
    p_commitment_id: body.commitment_id, p_due_date: body.due_date,
    p_amount_minor: body.amount_minor, p_paid_on: body.paid_on,
    p_expected_version: body.expected_version,
    p_expected_commitment_version: body.expected_commitment_version, p_reason: body.reason.trim(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "40001" ? 409 : 400 });
  return NextResponse.json({ payment: data });
}

export async function DELETE(request: NextRequest) {
  const auth = await authorize(true);
  if (auth.response) return auth.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "A payment correction is required" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || typeof body.commitment_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(body.commitment_id) || !isIsoDate(body.due_date) ||
      !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      !Number.isSafeInteger(body.expected_commitment_version) || Number(body.expected_commitment_version) < 1 ||
      typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "Select a recorded payment and explain the correction." }, { status: 400 });
  }
  const { data, error } = await auth.supabase.rpc("undo_finance_recurring_payment", {
    p_commitment_id: body.commitment_id, p_due_date: body.due_date,
    p_expected_version: body.expected_version, p_expected_commitment_version: body.expected_commitment_version,
    p_reason: body.reason.trim(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "40001" ? 409 : 400 });
  return NextResponse.json({ payment: data });
}
