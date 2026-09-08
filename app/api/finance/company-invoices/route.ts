import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }
  const permission = await hasFinanceCapability(supabase, "finance.view_company");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) return NextResponse.json({ error: "Company invoice access denied" }, { status: 403 });

  const focusId = request.nextUrl.searchParams.get("invoice");
  if (focusId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(focusId)) {
    return NextResponse.json({ error: "Invalid invoice ID" }, { status: 400 });
  }
  const fields = "id,expense_scope,supplier,invoice_number,invoice_date,due_date,currency_code,amount_ex_gst,gst,total,status,payment_status,amount_paid,paid_at,company_expense_category,recurring_commitment_id,recurring_due_date,created_at,finance_recurring_commitments(id,name,first_due_date,frequency,end_date)";
  const { data, error } = await supabase.from("invoices")
    .select(fields)
    .in("expense_scope", ["company", "unallocated"])
    .order("invoice_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (focusId && !data?.some((invoice) => invoice.id === focusId)) {
    const focused = await supabase.from("invoices").select(fields)
      .in("expense_scope", ["company", "unallocated"]).eq("id", focusId).maybeSingle();
    if (focused.error) return NextResponse.json({ error: focused.error.message }, { status: 500 });
    if (!focused.data) return NextResponse.json({ error: "That company bill was not found or is no longer accessible" }, { status: 404 });
    data?.unshift(focused.data);
  }
  return NextResponse.json({ invoices: data ?? [], can_edit_payment: user.role === "admin" });
}
