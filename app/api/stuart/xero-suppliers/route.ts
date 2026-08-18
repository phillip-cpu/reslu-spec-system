import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { createStuartXeroSupplierContact } from "@/lib/stuart/xero-supplier-contacts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as {
    invoice_id?: unknown;
    legal_name?: unknown;
    abn?: unknown;
    human_confirmed?: unknown;
  } | null;
  if (!body || typeof body.invoice_id !== "string" || typeof body.legal_name !== "string"
    || typeof body.abn !== "string" || body.human_confirmed !== true) {
    return NextResponse.json({ error: "invoice_id, legal_name, abn and human_confirmed=true are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await createStuartXeroSupplierContact({
      invoiceId: body.invoice_id,
      legalName: body.legal_name,
      abn: body.abn,
      humanConfirmed: body.human_confirmed,
      createdBy: user?.id ?? null,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Xero supplier contact failed" }, { status: 400 });
  }
}
