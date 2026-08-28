import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { sendTeamEmail, type EmailAttachment } from "@/lib/gmail/send";
import { ASSET_BUCKET } from "@/lib/storage";
import { buildSupplierQuoteEmail } from "@/lib/supplier-quotes";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: packageId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can send quote requests" }, { status: 403 });

  const { data: quotePackage } = await supabase.from("supplier_quote_packages").select("*").eq("id", packageId).is("deleted_at", null).maybeSingle();
  if (!quotePackage) return NextResponse.json({ error: "Quote package not found" }, { status: 404 });
  if (!["draft", "sent"].includes(quotePackage.status)) {
    return NextResponse.json({ error: "This quote package can no longer be sent" }, { status: 409 });
  }

  const [{ data: project }, { data: lines }, { data: requests }, { data: attachments }] = await Promise.all([
    supabase.from("projects").select("id,name,address").eq("id", quotePackage.project_id).maybeSingle(),
    supabase.from("supplier_quote_package_lines").select("*").eq("package_id", packageId).order("sort"),
    supabase.from("supplier_quote_requests").select("*").eq("package_id", packageId).eq("status", "draft"),
    supabase.from("supplier_quote_attachments").select("*").eq("package_id", packageId).eq("kind", "request").is("request_id", null).order("sort"),
  ]);
  if (!project || !lines?.length) return NextResponse.json({ error: "Quote package is incomplete" }, { status: 400 });
  if (!requests?.length) return NextResponse.json({ error: "All supplier requests in this package have already been sent" }, { status: 409 });

  const contactIds = requests.map((row) => row.contact_id).filter(Boolean) as string[];
  const { data: contacts } = await supabase.from("contacts").select("id,company,contact_name,email").in("id", contactIds);
  const contactById = new Map((contacts ?? []).map((row) => [row.id, row]));

  const emailAttachments: EmailAttachment[] = [];
  for (const attachment of attachments ?? []) {
    const { data: blob, error } = await supabase.storage.from(ASSET_BUCKET).download(attachment.storage_path);
    if (error || !blob) return NextResponse.json({ error: `Could not load attachment ${attachment.filename}` }, { status: 500 });
    emailAttachments.push({ filename: attachment.filename, contentType: attachment.mime || blob.type || "application/octet-stream", content: Buffer.from(await blob.arrayBuffer()) });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ?? "https://spec.reslu.com.au").replace(/\/+$/, "");
  const sent = [];
  const errors: string[] = [];
  const now = new Date().toISOString();
  for (const supplierRequest of requests) {
    const contact = supplierRequest.contact_id ? contactById.get(supplierRequest.contact_id) : null;
    const to = contact?.email ?? supplierRequest.sent_to_email;
    if (!to) {
      errors.push(`${contact?.company ?? "Supplier"}: missing email`);
      continue;
    }
    const reference = `RFQ-${supplierRequest.id.slice(0, 8).toUpperCase()}`;
    const message = buildSupplierQuoteEmail({
      requestReference: reference,
      projectName: project.name,
      projectAddress: project.address,
      packageTitle: quotePackage.title,
      scope: quotePackage.scope,
      requestedQuoteDate: quotePackage.requested_quote_date,
      responseUrl: `${appUrl}/quote-request/${supplierRequest.token}`,
      lines: lines.map((line) => ({ description: line.description_snapshot, qty: line.qty_snapshot, unit: line.unit_snapshot })),
      attachmentNames: (attachments ?? []).map((row) => row.filename),
    });
    try {
      const result = await sendTeamEmail({ to: [to], subject: message.subject, body: message.body, attachments: emailAttachments });
      if (result.skipped || !result.provider_message_id) throw new Error(result.reason ?? "Email transport unavailable");
      const { data: updated, error: updateError } = await supabase.from("supplier_quote_requests").update({
        status: "sent",
        sent_at: now,
        sent_to_email: to,
        provider_message_id: result.provider_message_id,
        provider_thread_id: result.provider_thread_id ?? null,
      }).eq("id", supplierRequest.id).eq("status", "draft").select().single();
      if (updateError || !updated) throw new Error(updateError?.message ?? "Could not record sent request");
      sent.push(updated);
    } catch (error) {
      errors.push(`${contact?.company ?? to}: ${error instanceof Error ? error.message : "Send failed"}`);
    }
  }

  if (sent.length > 0) {
    await supabase.from("supplier_quote_packages").update({ status: "sent", sent_at: now }).eq("id", packageId);
    await supabase.from("cost_lines").update({ quote_status: "S" }).in("id", lines.map((line) => line.cost_line_id));
  }
  return NextResponse.json({ sent, errors }, { status: sent.length > 0 ? 200 : 502 });
}
