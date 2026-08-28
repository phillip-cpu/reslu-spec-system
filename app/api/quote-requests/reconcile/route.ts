import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { extractPromisedQuoteDate } from "@/lib/supplier-quotes";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  const cronAllowed = !!process.env.CRON_SECRET && authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAllowed) {
    const session = await createClient();
    const info = await getUserRole(session);
    if (!info || info.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const { data: activeRequests, error } = await supabase.from("supplier_quote_requests")
    .select("id,promised_quote_at,status")
    .in("status", ["sent", "acknowledged"])
    .is("promised_quote_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const requestIds = (activeRequests ?? []).map((row) => row.id);
  if (requestIds.length === 0) return NextResponse.json({ checked: 0, updated: 0 });

  const { data: links } = await supabase.from("supplier_quote_request_emails").select("request_id,email_id").in("request_id", requestIds);
  const emailIds = [...new Set((links ?? []).map((row) => row.email_id))];
  const { data: emails } = emailIds.length
    ? await supabase.from("emails").select("id,direction,received_at,clean_text").in("id", emailIds).eq("direction", "inbound").order("received_at", { ascending: false })
    : { data: [] as { id: string; direction: string; received_at: string; clean_text: string | null }[] };
  const requestByEmail = new Map((links ?? []).map((link) => [link.email_id, link.request_id]));
  const handled = new Set<string>();
  let updated = 0;
  for (const email of emails ?? []) {
    const requestId = requestByEmail.get(email.id);
    if (!requestId || handled.has(requestId) || !email.clean_text) continue;
    handled.add(requestId);
    const promised = extractPromisedQuoteDate(email.clean_text, email.received_at);
    if (!promised) continue;
    const { error: updateError } = await supabase.from("supplier_quote_requests").update({ promised_quote_at: promised, status: "acknowledged" }).eq("id", requestId).in("status", ["sent", "acknowledged"]);
    if (!updateError) updated += 1;
  }
  return NextResponse.json({ checked: requestIds.length, updated });
}
