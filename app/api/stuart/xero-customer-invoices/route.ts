import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { createStuartXeroDraftCustomerInvoice, customerInvoiceSource } from "@/lib/stuart/xero-customer-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try { return NextResponse.json(await customerInvoiceSource(request.nextUrl.searchParams.get("source_attachment_id") ?? "")); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Source unavailable" }, { status: 400 }); }
}

export async function POST(request: NextRequest) {
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user || !isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await createStuartXeroDraftCustomerInvoice(await request.json(), request.headers.get("x-reslu-action-run-id") ?? "", user.id));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Customer draft failed" }, { status: 400 }); }
}
