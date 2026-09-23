import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { CreateCostLineSourcePaymentInput } from "@/types/foreign-cost-cash";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Records an evidence-backed payment in the supplier's source currency.
 * settled_aud_minor is optional on purpose: an unknown bank settlement must
 * never be replaced by a planning exchange rate. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit estimate cash history" }, { status: 403 });
  }

  let body: CreateCostLineSourcePaymentInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.source_amount_minor) || body.source_amount_minor <= 0) {
    return NextResponse.json({ error: "source_amount_minor must be a positive integer" }, { status: 400 });
  }
  if (body.paid_on != null && !ISO_DATE.test(body.paid_on)) {
    return NextResponse.json({ error: "paid_on must be an ISO date when known" }, { status: 400 });
  }
  if (
    body.settled_aud_minor !== undefined && body.settled_aud_minor !== null &&
    (!Number.isSafeInteger(body.settled_aud_minor) || body.settled_aud_minor < 0)
  ) {
    return NextResponse.json({ error: "settled_aud_minor must be a non-negative integer" }, { status: 400 });
  }

  const [{ data: line }, { data: payments }] = await Promise.all([
    supabase
      .from("cost_lines")
      .select("id,source_currency,source_forecast_total_minor")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("cost_line_source_payments")
      .select("source_amount_minor")
      .eq("cost_line_id", id),
  ]);
  if (!line) return NextResponse.json({ error: "Cost line not found" }, { status: 404 });
  if (!line.source_currency || line.source_forecast_total_minor === null) {
    return NextResponse.json(
      { error: "Set the source currency and confirmed forecast amount before recording payments" },
      { status: 409 }
    );
  }
  const alreadyPaid = (payments ?? []).reduce(
    (sum, payment) => sum + Number(payment.source_amount_minor),
    0
  );
  if (alreadyPaid + body.source_amount_minor > Number(line.source_forecast_total_minor)) {
    return NextResponse.json({ error: "Source payments cannot exceed the source total" }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("cost_line_source_payments")
    .insert({
      cost_line_id: id,
      source_amount_minor: body.source_amount_minor,
      paid_on: body.paid_on ?? null,
      settled_aud_minor: body.settled_aud_minor ?? null,
      evidence_reference: body.evidence_reference?.trim() || null,
      created_by: user.userId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ payment: data }, { status: 201 });
}
