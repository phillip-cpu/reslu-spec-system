import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { createClient } from "@/lib/supabase/server";
import type {
  FinanceCreditFacility,
  SaveFinanceCreditFacilityRequest,
} from "@/types/finance";

export const runtime = "nodejs";

const VALID_TYPES = new Set(["overdraft", "credit_card", "line_of_credit", "other"]);
const VALID_STATUSES = new Set(["active", "paused", "closed"]);

function normalize(row: Record<string, unknown>): FinanceCreditFacility {
  const limit = Number(row.credit_limit_minor);
  const balance = Number(row.current_balance_minor);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(balance) || balance < 0) {
    throw new Error(`${String(row.id)} has an invalid facility balance`);
  }
  return {
    ...row,
    credit_limit_minor: limit,
    current_balance_minor: balance,
    available_credit_minor: Math.max(limit - balance, 0),
  } as FinanceCreditFacility;
}

async function financeUser() {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await financeUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  const [view, edit] = await Promise.all([
    hasFinanceCapability(supabase, "finance.view_company"),
    hasFinanceCapability(supabase, "finance.edit_forecast"),
  ]);
  if (view.error ?? edit.error) return NextResponse.json({ error: view.error ?? edit.error }, { status: 500 });
  if (!view.allowed && !edit.allowed) return NextResponse.json({ error: "Credit facility access denied" }, { status: 403 });

  const { data, error } = await supabase
    .from("finance_credit_facilities")
    .select("*")
    .neq("status", "closed")
    .order("status")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    const facilities = ((data ?? []) as Record<string, unknown>[]).map(normalize);
    const active = facilities.filter((item) => item.status === "active");
    return NextResponse.json({
      facilities,
      can_edit: edit.allowed,
      summary: {
        credit_limit_minor: active.reduce((sum, item) => sum + item.credit_limit_minor, 0),
        current_balance_minor: active.reduce((sum, item) => sum + item.current_balance_minor, 0),
        available_credit_minor: active.reduce((sum, item) => sum + item.available_credit_minor, 0),
        active_count: active.length,
      },
    });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Could not read credit facilities" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await financeUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  const permission = await hasFinanceCapability(supabase, "finance.edit_forecast");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) return NextResponse.json({ error: "Credit facility edit denied" }, { status: 403 });

  const body = (await request.json()) as SaveFinanceCreditFacilityRequest;
  if (!body.name?.trim() || !body.reason?.trim()) return NextResponse.json({ error: "Name and change reason are required" }, { status: 400 });
  if (!VALID_TYPES.has(body.facility_type) || !VALID_STATUSES.has(body.status)) return NextResponse.json({ error: "Facility type or status is invalid" }, { status: 400 });
  if (!Number.isSafeInteger(body.credit_limit_minor) || body.credit_limit_minor <= 0 || !Number.isSafeInteger(body.current_balance_minor) || body.current_balance_minor < 0) {
    return NextResponse.json({ error: "Limit and current balance must be valid minor-unit integers" }, { status: 400 });
  }
  if (body.interest_rate_bps !== null && body.interest_rate_bps !== undefined && (!Number.isInteger(body.interest_rate_bps) || body.interest_rate_bps < 0 || body.interest_rate_bps > 100000)) {
    return NextResponse.json({ error: "Interest rate must be between 0 and 1,000%" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("save_finance_credit_facility", {
    p_id: body.id ?? null,
    p_name: body.name,
    p_provider: body.provider ?? null,
    p_facility_type: body.facility_type,
    p_credit_limit_minor: body.credit_limit_minor,
    p_current_balance_minor: body.current_balance_minor,
    p_interest_rate_bps: body.interest_rate_bps ?? null,
    p_status: body.status,
    p_notes: body.notes ?? null,
    p_expected_version: body.expected_version ?? null,
    p_reason: body.reason,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  try {
    return NextResponse.json({ facility: normalize(data as Record<string, unknown>) });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Could not save credit facility" }, { status: 422 });
  }
}
