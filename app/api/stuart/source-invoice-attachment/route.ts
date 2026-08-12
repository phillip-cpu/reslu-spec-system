import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { attachStuartSourceInvoice } from "@/lib/stuart/source-invoice-attachment";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as { invoice_id?: unknown; email_attachment_id?: unknown } | null;
  if (!body || typeof body.invoice_id !== "string" || typeof body.email_attachment_id !== "string") {
    return NextResponse.json({ error: "invoice_id and email_attachment_id are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await attachStuartSourceInvoice({
      invoiceId: body.invoice_id,
      emailAttachmentId: body.email_attachment_id,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Source invoice attachment failed" }, { status: 400 });
  }
}
