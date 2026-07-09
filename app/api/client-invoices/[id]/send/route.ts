import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { InvoicePdf } from "@/components/pdf/InvoicePdf";
import { loadClientInvoicePdfData } from "@/lib/client-invoice-pdf-data";
import { sendViaResend } from "@/lib/resend";
import { reportError } from "@/lib/report-error";
import type { ClientInvoice } from "@/types/client-invoices";

// react-pdf (font/logo file reads) requires the Node runtime.
export const runtime = "nodejs";

const INVOICE_FROM = "RESLU <accounts@reslu.com.au>";
const INVOICE_REPLY_TO = "phillip@reslu.com.au";

// Resend's documented request-body cap is 40MB, but this codebase's own
// convention (see BUILD-SPEC.md this round: "attach the PDF directly
// ... fall back to a note if >5MB — document") is a much tighter 5MB
// guard specifically for invoice PDFs, since a design-fee tax invoice
// should never legitimately be anywhere near that large — a PDF over
// 5MB here is far more likely a rendering bug (e.g. a runaway line
// items list) than a real invoice, so it's safer to degrade to a
// text-only email with a note than to silently ship a bloated
// attachment.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/client-invoices/[id]/send
 * Admin-only. Body: none. Emails the branded tax invoice PDF to
 * client_email via Resend (BUILD-SPEC.md this round: "attach the PDF
 * directly, cleaner for invoices"), logs to email_sends
 * (record_type='client_invoice'), and — on a real (non-skipped) send —
 * flips status to 'sent' and sets issued_at (first-send timestamp,
 * preserved across any later resend).
 *
 * DIVERGENCE FROM lib/visit-emails.ts: the 7am-7pm Adelaide send-window
 * rule is deliberately NOT applied here. That rule exists for
 * unsolicited/interruptive client-facing messages (a booking
 * confirmation landing in someone's inbox at 2am reads as odd); an
 * invoice the admin explicitly clicked "Send" on is a deliberate,
 * on-demand business action with no such social-timing concern —
 * BUILD-SPEC.md this round explicitly calls this divergence out:
 * "invoices are fine anytime — document divergence". No email_sends
 * 'pending'/scheduled_for queuing path exists for this record_type as
 * a result — a send either goes out now or fails now.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can send client invoices" }, { status: 403 });
  }

  const data = await loadClientInvoicePdfData(supabase, id);
  if (!data) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const { invoice } = data;
  if (invoice.status === "void") {
    return NextResponse.json({ error: "A voided invoice cannot be sent" }, { status: 400 });
  }
  // The shipped UI only ever shows "Send" for status='draft', so this
  // is currently unreachable through the app — but the route itself is
  // the real gate (same posture as every other admin action here), and
  // without this it would silently revert an already-paid invoice back
  // to 'sent' if ever hit directly, leaving paid_at set on a row that
  // no longer says paid.
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "A paid invoice cannot be re-sent" }, { status: 400 });
  }
  if (!invoice.client_email) {
    return NextResponse.json(
      { error: "This invoice has no client_email — add one before sending" },
      { status: 400 }
    );
  }

  const buffer = await renderToBuffer(InvoicePdf(data));
  const base64 = Buffer.from(buffer).toString("base64");
  const attachmentTooLarge = buffer.byteLength > MAX_ATTACHMENT_BYTES;

  const subject = `RESLU tax invoice ${invoice.invoice_number}`;
  const html = buildInvoiceEmailHtml(invoice, attachmentTooLarge);

  let sendResult: { skipped: boolean; reason?: string };
  try {
    sendResult = await sendViaResend({
      from: INVOICE_FROM,
      to: [invoice.client_email],
      replyTo: INVOICE_REPLY_TO,
      subject,
      html,
      attachments: attachmentTooLarge
        ? undefined
        : [{ filename: `RESLU-Invoice-${invoice.invoice_number}.pdf`, content: base64 }],
    });
  } catch (err) {
    await reportError("client-invoice-send", err);
    await supabase.from("email_sends").insert({
      record_type: "client_invoice",
      record_id: invoice.id,
      template: "client-invoice",
      to_email: invoice.client_email,
      status: "skipped",
      detail: { subject, reason: "Resend send failed" },
    });
    return NextResponse.json({ error: "Could not send invoice email" }, { status: 502 });
  }

  if (sendResult.skipped) {
    await supabase.from("email_sends").insert({
      record_type: "client_invoice",
      record_id: invoice.id,
      template: "client-invoice",
      to_email: invoice.client_email,
      status: "skipped",
      detail: { subject, reason: sendResult.reason },
    });
    return NextResponse.json(
      { error: `Invoice not sent: ${sendResult.reason ?? "Resend not configured"}` },
      { status: 503 }
    );
  }

  const now = new Date().toISOString();
  await supabase.from("email_sends").insert({
    record_type: "client_invoice",
    record_id: invoice.id,
    template: "client-invoice",
    to_email: invoice.client_email,
    status: "sent",
    sent_at: now,
    detail: { subject, attachment_omitted: attachmentTooLarge },
  });

  const { data: updated, error: updateError } = await supabase
    .from("client_invoices")
    .update({ status: "sent", issued_at: invoice.issued_at ?? now })
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    // The email genuinely went out — don't report this as a failed
    // send, but do surface the status write's failure so the admin
    // knows to check the row.
    return NextResponse.json(
      { warning: `Invoice emailed, but status update failed: ${updateError.message}` },
      { status: 207 }
    );
  }

  return NextResponse.json({ invoice: updated as ClientInvoice, attachment_omitted: attachmentTooLarge });
}

/** Simple branded HTML body, inline (no template file — BUILD-SPEC.md
 * this round: "simple branded HTML body (inline, no template file)").
 * Deliberately plain (no external images/hero, unlike
 * emails/visit-*.html) — this is a short transactional business email,
 * not a lifecycle/marketing-adjacent one. */
function buildInvoiceEmailHtml(invoice: ClientInvoice, attachmentOmitted: boolean): string {
  const amount = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(invoice.total_inc_gst);

  const attachmentNote = attachmentOmitted
    ? `<p style="color:#313131;font-size:14px;">This invoice's PDF was too large to attach directly — please contact ${INVOICE_REPLY_TO} for a copy.</p>`
    : `<p style="color:#313131;font-size:14px;">Your tax invoice is attached as a PDF.</p>`;

  return `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;">
      <p style="letter-spacing:2px;text-transform:uppercase;font-size:11px;color:#A08C72;font-weight:bold;">RESLU</p>
      <h1 style="font-size:22px;color:#1A1A1A;margin:8px 0 16px;">Tax invoice ${invoice.invoice_number}</h1>
      <p style="color:#313131;font-size:14px;">Hi ${escapeHtml(invoice.client_name)},</p>
      <p style="color:#313131;font-size:14px;">
        Please find your RESLU tax invoice for <strong>${amount}</strong> (inc. GST), due within
        ${invoice.due_days} days.
      </p>
      ${attachmentNote}
      <p style="color:#313131;font-size:14px;">
        Payment details are on the invoice. Reference: <strong>${invoice.invoice_number}</strong>.
      </p>
      <p style="color:#313131;font-size:14px;">Thank you,<br/>RESLU</p>
      <p style="color:#A08C72;font-size:11px;margin-top:24px;">219 Sturt Street, Adelaide · reslu.com.au</p>
    </div>
  `.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
