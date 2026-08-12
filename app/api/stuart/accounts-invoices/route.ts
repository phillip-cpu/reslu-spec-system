import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isCronRequest, isStuartUser } from "@/lib/stuart/access";
import { processAccountsInvoice } from "@/lib/stuart/accounts-invoice-automation";

export const runtime = "nodejs";
const BATCH_SIZE = 10;

export async function POST(request: NextRequest) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const service = createServiceRoleClient();
  const body = await request.json().catch(() => ({})) as { email_id?: unknown };
  let ids: string[];
  if (typeof body.email_id === "string") {
    ids = [body.email_id];
  } else {
    const { data, error } = await service.from("emails").select("id")
      .contains("ingested_mailboxes", ["accounts@reslu.com.au"])
      .in("status", ["matched", "proposed", "review"])
      .not("extraction->supplier_invoice", "is", null)
      .order("received_at", { ascending: true }).limit(BATCH_SIZE);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    ids = (data ?? []).map((row) => row.id);
  }
  const results = [];
  for (const id of ids) {
    try { results.push({ email_id: id, ...(await processAccountsInvoice(id)) }); }
    catch (error) { results.push({ email_id: id, outcome: "manual_review", reason: error instanceof Error ? error.message : "Automation failed" }); }
  }
  return NextResponse.json({ processed: results.length, results });
}
