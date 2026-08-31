import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { sendTeamEmail } from "@/lib/gmail/send";
import { createClient } from "@/lib/supabase/server";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can send quote follow-ups" }, { status: 403 });

  const { data: quoteRequest } = await supabase.from("supplier_quote_requests").select("*").eq("id", id).maybeSingle();
  if (!quoteRequest) return NextResponse.json({ error: "Quote request not found" }, { status: 404 });
  if (["quote_received", "declined", "selected", "closed"].includes(quoteRequest.status)) return NextResponse.json({ error: "This quote request no longer needs follow-up" }, { status: 409 });
  const [{ data: quotePackage }, { data: contact }] = await Promise.all([
    supabase.from("supplier_quote_packages").select("title,project_id").eq("id", quoteRequest.package_id).maybeSingle(),
    quoteRequest.contact_id ? supabase.from("contacts").select("company,email").eq("id", quoteRequest.contact_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!quotePackage) return NextResponse.json({ error: "Quote package not found" }, { status: 404 });
  const { data: project } = await supabase.from("projects").select("name").eq("id", quotePackage.project_id).maybeSingle();
  const to = contact?.email ?? quoteRequest.sent_to_email;
  if (!to) return NextResponse.json({ error: "Supplier has no email address" }, { status: 400 });
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au").replace(/\/+$/, "");
  const reference = `RFQ-${quoteRequest.id.slice(0, 8).toUpperCase()}`;
  const result = await sendTeamEmail({
    to: [to],
    subject: `[${reference}] Follow-up — ${project?.name ?? "Project"} — ${quotePackage.title}`,
    body: `Hello,\n\nJust following up on our quote request for ${quotePackage.title}. Please confirm when you expect to return the quotation.\n\nView or respond here: ${appUrl}/quote-request/${quoteRequest.token}\n\nRegards,\nRESLU`,
  });
  if (result.skipped) return NextResponse.json({ error: result.reason ?? "Email transport unavailable" }, { status: 503 });
  await supabase.from("supplier_quote_requests").update({ last_followup_at: new Date().toISOString() }).eq("id", id);
  return NextResponse.json({ ok: true });
}
