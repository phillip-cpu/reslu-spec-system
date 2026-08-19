import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { stageCompanyExpenseInvoice } from "@/lib/stuart/company-expense-invoices";
import type { FinanceRecurringCategory } from "@/types/finance";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as {
    email_id?: unknown;
    category?: unknown;
    recurring_commitment_id?: unknown;
    human_confirmed?: unknown;
  } | null;
  if (!body || typeof body.email_id !== "string" || typeof body.category !== "string"
    || body.human_confirmed !== true) {
    return NextResponse.json({ error: "email_id, category and human_confirmed=true are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await stageCompanyExpenseInvoice({
      emailId: body.email_id,
      category: body.category as FinanceRecurringCategory,
      recurringCommitmentId: typeof body.recurring_commitment_id === "string"
        ? body.recurring_commitment_id : null,
      humanConfirmed: true,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Company invoice staging failed" }, { status: 400 });
  }
}
