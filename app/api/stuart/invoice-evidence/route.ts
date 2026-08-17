import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const AMOUNT = /\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})/g;

function numericAmount(value: string): number | null {
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

export async function GET(request: NextRequest) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const invoiceId = request.nextUrl.searchParams.get("invoice_id")?.trim() ?? "";
  if (!UUID.test(invoiceId)) return NextResponse.json({ error: "A valid invoice_id is required" }, { status: 400 });

  const service = createServiceRoleClient();
  const { data: invoice, error: invoiceError } = await service
    .from("invoices")
    .select("id,supplier,invoice_number,invoice_date,amount_ex_gst,gst,total,status,source_email_id,storage_path,updated_at")
    .eq("id", invoiceId)
    .single();
  if (invoiceError || !invoice) return NextResponse.json({ error: invoiceError?.message ?? "Supplier invoice was not found" }, { status: 404 });

  if (!invoice.source_email_id) {
    return NextResponse.json({
      invoice: { ...invoice, storage_path: undefined, source_document_attached: Boolean(invoice.storage_path) },
      attachments: [],
      blocker: "This Spec invoice has no traceable source email. It may be an incomplete legacy entry, duplicate or quote and cannot become a Xero draft without human correction.",
    });
  }

  const { data: attachments, error: attachmentError } = await service
    .from("email_attachments")
    .select("id,email_id,filename,mime,storage_ref,content_sha256,extracted_text")
    .eq("email_id", invoice.source_email_id);
  if (attachmentError) return NextResponse.json({ error: attachmentError.message }, { status: 500 });

  const invoiceTotal = Number(invoice.total);
  const candidates = (attachments ?? [])
    .filter((attachment) => attachment.mime === "application/pdf" || attachment.filename?.toLowerCase().endsWith(".pdf"))
    .map((attachment) => {
      const evidenceText = typeof attachment.extracted_text === "string" ? attachment.extracted_text : "";
      const tokens: string[] = [...new Set(evidenceText.match(AMOUNT) ?? [])];
      const amounts = tokens.map(numericAmount).filter((value): value is number => value !== null);
      const readableEvidence = Boolean(evidenceText.trim());
      const fingerprintVerified = SHA256.test(attachment.content_sha256 ?? "");
      const stored = Boolean(attachment.storage_ref);
      return {
        email_attachment_id: attachment.id,
        filename: attachment.filename,
        mime: attachment.mime,
        content_sha256: attachment.content_sha256,
        stored,
        fingerprint_verified: fingerprintVerified,
        readable_evidence: readableEvidence,
        amount_tokens: tokens.slice(0, 40),
        invoice_total_present: Number.isFinite(invoiceTotal) && amounts.includes(Math.round(invoiceTotal * 100) / 100),
        attached_to_invoice: Boolean(invoice.storage_path && invoice.storage_path === attachment.storage_ref),
        eligible_for_attachment: !["rejected", "voided"].includes(invoice.status) && stored && fingerprintVerified && readableEvidence,
      };
    });

  return NextResponse.json({
    invoice: { ...invoice, storage_path: undefined, source_document_attached: Boolean(invoice.storage_path) },
    attachments: candidates,
    blocker: ["rejected", "voided"].includes(invoice.status)
      ? `The Spec invoice is ${invoice.status}; correct or replace that record before any Xero draft.`
      : null,
    authority: "Read-only evidence inspection. No Spec or Xero record was changed.",
  });
}
