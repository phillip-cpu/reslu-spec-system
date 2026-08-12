import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { createStuartXeroDraftBill } from "@/lib/stuart/xero-draft-bills";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as { invoice_id?: unknown; account_code?: unknown } | null;
  if (!body || typeof body.invoice_id !== "string" || typeof body.account_code !== "string") {
    return NextResponse.json({ error: "invoice_id and account_code are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await createStuartXeroDraftBill({
      invoiceId: body.invoice_id,
      accountCode: body.account_code,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Xero draft bill failed" }, { status: 400 });
  }
}
