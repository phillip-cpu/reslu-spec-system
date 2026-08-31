import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) {
    return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  }
  const permission = await hasFinanceCapability(supabase, "finance.view_company");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) return NextResponse.json({ error: "Company invoice access denied" }, { status: 403 });

  const { data, error } = await supabase.from("invoices")
    .select("id,expense_scope,supplier,invoice_number,invoice_date,currency_code,amount_ex_gst,gst,total,status,company_expense_category,recurring_commitment_id,created_at,finance_recurring_commitments(name)")
    .in("expense_scope", ["company", "unallocated"])
    .order("invoice_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoices: data ?? [] });
}
