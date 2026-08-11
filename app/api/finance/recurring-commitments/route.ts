import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { generateRecurringContributions } from "@/lib/finance/recurrence";
import { isIsoDate } from "@/lib/finance/readiness";
import { createClient } from "@/lib/supabase/server";
import type {
  FinanceRecurringCommitment,
  SaveFinanceRecurringCommitmentRequest,
} from "@/types/finance";

export const runtime = "nodejs";

const VALID_CATEGORIES = new Set([
  "wages",
  "superannuation",
  "rent",
  "marketing",
  "entertainment",
  "software",
  "insurance",
  "utilities",
  "professional_fees",
  "vehicles",
  "other",
]);
const VALID_FREQUENCIES = new Set([
  "once",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "annually",
]);

function normalizeCommitment(row: Record<string, unknown>): FinanceRecurringCommitment {
  const amount = Number(row.amount_minor);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${String(row.id)}.amount_minor is outside safe minor-unit range`);
  }
  return { ...row, amount_minor: amount } as unknown as FinanceRecurringCommitment;
}

async function financeUser() {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  return { supabase, user };
}

export async function GET(request: NextRequest) {
  const { supabase, user } = await financeUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }
  const [viewPermission, editPermission] = await Promise.all([
    hasFinanceCapability(supabase, "finance.view_company"),
    hasFinanceCapability(supabase, "finance.edit_forecast"),
  ]);
  if (viewPermission.error) {
    return NextResponse.json({ error: viewPermission.error }, { status: 500 });
  }
  if (!viewPermission.allowed && !editPermission.allowed) {
    return NextResponse.json({ error: "Recurring commitment access denied" }, { status: 403 });
  }

  const asOfDate = request.nextUrl.searchParams.get("as_of_date") ??
    new Date().toISOString().slice(0, 10);
  if (!isIsoDate(asOfDate)) {
    return NextResponse.json({ error: "as_of_date must be an ISO calendar date" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("finance_recurring_commitments")
    .select("*")
    .neq("status", "archived")
    .order("status", { ascending: true })
    .order("first_due_date", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    const commitments = ((data ?? []) as Record<string, unknown>[]).map(normalizeCommitment);
    const contributions = generateRecurringContributions({ commitments, asOfDate });
    return NextResponse.json({
      commitments,
      can_edit: !editPermission.error && editPermission.allowed,
      as_of_date: asOfDate,
      summary: {
        active_count: commitments.filter((item) => item.status === "active").length,
        projected_outflow_minor: contributions.reduce(
          (sum, item) => sum + item.plannedMinor,
          0
        ),
        next_due_date: contributions[0]?.plannedDate ?? null,
      },
    });
  } catch (caught) {
    return NextResponse.json(
      { error: caught instanceof Error ? caught.message : "Could not read commitments" },
      { status: 422 }
    );
  }
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await financeUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }
  const permission = await hasFinanceCapability(supabase, "finance.edit_forecast");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) {
    return NextResponse.json({ error: "Recurring commitment edit denied" }, { status: 403 });
  }

  const body = (await request.json()) as SaveFinanceRecurringCommitmentRequest;
  if (!body.name?.trim() || !body.reason?.trim()) {
    return NextResponse.json({ error: "Name and change reason are required" }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.amount_minor) || body.amount_minor <= 0) {
    return NextResponse.json({ error: "Amount must be a positive minor-unit integer" }, { status: 400 });
  }
  if (!VALID_CATEGORIES.has(body.category) || !VALID_FREQUENCIES.has(body.frequency)) {
    return NextResponse.json({ error: "Category or schedule is not supported" }, { status: 400 });
  }
  if (!isIsoDate(body.first_due_date) || (body.end_date && !isIsoDate(body.end_date))) {
    return NextResponse.json({ error: "Due dates must be ISO calendar dates" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("save_finance_recurring_commitment", {
    p_id: body.id ?? null,
    p_name: body.name,
    p_category: body.category,
    p_supplier_or_payee: body.supplier_or_payee ?? null,
    p_amount_minor: body.amount_minor,
    p_frequency: body.frequency,
    p_first_due_date: body.first_due_date,
    p_end_date: body.frequency === "once" ? null : body.end_date || null,
    p_gst_treatment: body.gst_treatment,
    p_annual_escalation_bps:
      body.frequency === "once" ? 0 : body.annual_escalation_bps,
    p_confidence: body.confidence,
    p_status: body.status,
    p_notes: body.notes ?? null,
    p_expected_version: body.expected_version ?? null,
    p_reason: body.reason,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  try {
    return NextResponse.json({ commitment: normalizeCommitment(data as Record<string, unknown>) });
  } catch (caught) {
    return NextResponse.json(
      { error: caught instanceof Error ? caught.message : "Could not save commitment" },
      { status: 422 }
    );
  }
}
