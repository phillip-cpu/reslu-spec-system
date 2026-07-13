import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { InvoicePdf } from "@/components/pdf/InvoicePdf";
import { loadClientInvoicePdfData } from "@/lib/client-invoice-pdf-data";
import { sendViaResend } from "@/lib/resend";
import { reportError } from "@/lib/report-error";
import type { ClientInvoice } from "@/types/client-invoices";

// react-pdf (font/logo file reads) requires the Node runtime — same as
// POST /api/client-invoices/[id]/send (this route's sibling).
export const runtime = "nodejs";

// Duplicated (deliberately, not imported) from POST
// /api/client-invoices/[id]/send/route.ts — a route.ts file's only
// framework-recognised exports are the HTTP method handlers + the few
// special route-segment configs (runtime/dynamic/etc.), so exporting
// plain helper constants from that file for cross-file reuse would be
// an unconventional pattern with no precedent anywhere else in this
// codebase (grepped `app/api/**/route.ts` for `^export (function|
// const)` before writing this — every hit is a route-segment config).
// Same values, same sender identity — keep in sync by hand if either
// ever changes.
const INVOICE_FROM = "RESLU <accounts@reslu.com.au>";
const INVOICE_REPLY_TO = "phillip@reslu.com.au";
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/client-invoices/[id]/resend
 *
 * BUILD-SPEC.md r27 item 8 — "Stripe recovery ... allow creating the
 * payment link and RE-SENDING an updated invoice ... prevent the
 * dead-end ordering." Root cause: POST .../send only ever gets offered
 * by the UI while status='draft' (see that route's own doc comment),
 * and the invoice flips to 'sent' the moment it fires — so an admin
 * who clicked Send BEFORE clicking "Create payment link" (both actions
 * are available independently, in either order, on a 'sent' invoice —
 * see stripe-link/route.ts, which only blocks void/paid) had no way to
 * get the now-updated PDF (with its "Pay online" button —
 * components/pdf/InvoicePdf.tsx renders it whenever
 * invoice.stripe_payment_url is set) back to the client. This route is
 * the missing second rung: same render/email mechanics as .../send,
 * but ONLY for an invoice already at status='sent' (a 'draft' invoice
 * uses .../send; void/paid are still refused, unchanged).
 *
 * Dedupe guard: refuses (400) a resend whose stripe_payment_url AND
 * total_inc_gst are IDENTICAL to the last 'sent' email_sends row's
 * snapshot for this invoice — i.e. nothing has actually changed since
 * the client was last emailed, so a second click can't spam an
 * unchanged invoice. A resend after a real change (a payment link just
 * created, a total that was corrected) always goes through. Logged
 * with its own template ('client-invoice-resend', distinct from the
 * first send's 'client-invoice') and subject prefix "Updated invoice"
 * so the email_sends history and the client's inbox both read as an
 * update, not a duplicate original.
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
    return NextResponse.json({ error: "Only admins can resend client invoices" }, { status: 403 });
  }

  const data = await loadClientInvoicePdfData(supabase, id);
  if (!data) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const { invoice } = data;
  if (invoice.status === "void") {
    return NextResponse.json({ error: "A voided invoice cannot be resent" }, { status: 400 });
  }
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "A paid invoice cannot be resent" }, { status: 400 });
  }
  if (invoice.status === "draft") {
    return NextResponse.json({ error: "This invoice hasn't been sent yet — use Send first" }, { status: 400 });
  }
  if (!invoice.client_email) {
    return NextResponse.json(
      { error: "This invoice has no client_email — add one before resending" },
      { status: 400 }
    );
  }

  // Dedupe guard — see this route's own doc comment. Compares against
  // the most recent 'sent' email_sends row for THIS invoice, across
  // either template (the original send or a prior resend).
  const { data: lastSent } = await supabase
    .from("email_sends")
    .select("detail")
    .eq("record_type", "client_invoice")
    .eq("record_id", invoice.id)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastDetail = (lastSent?.detail ?? null) as
    | { stripe_payment_url?: string | null; total_inc_gst?: number }
    | null;
  if (
    lastDetail &&
    (lastDetail.stripe_payment_url ?? null) === (invoice.stripe_payment_url ?? null) &&
    lastDetail.total_inc_gst === invoice.total_inc_gst
  ) {
    return NextResponse.json(
      { error: "Nothing has changed on this invoice since it was last sent — nothing to resend." },
      { status: 400 }
    );
  }

  const buffer = await renderToBuffer(InvoicePdf(data));
  const base64 = Buffer.from(buffer).toString("base64");
  const attachmentTooLarge = buffer.byteLength > MAX_ATTACHMENT_BYTES;

  const subject = `RESLU updated invoice ${invoice.invoice_number}`;
  const html = buildResendEmailHtml(invoice, attachmentTooLarge);

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
    await reportError("client-invoice-resend", err);
    await supabase.from("email_sends").insert({
      record_type: "client_invoice",
      record_id: invoice.id,
      template: "client-invoice-resend",
      to_email: invoice.client_email,
      status: "skipped",
      detail: { subject, reason: "Resend send failed" },
    });
    return NextResponse.json({ error: "Could not resend invoice email" }, { status: 502 });
  }

  if (sendResult.skipped) {
    await supabase.from("email_sends").insert({
      record_type: "client_invoice",
      record_id: invoice.id,
      template: "client-invoice-resend",
      to_email: invoice.client_email,
      status: "skipped",
      detail: { subject, reason: sendResult.reason },
    });
    return NextResponse.json(
      { error: `Invoice not resent: ${sendResult.reason ?? "Resend not configured"}` },
      { status: 503 }
    );
  }

  const now = new Date().toISOString();
  await supabase.from("email_sends").insert({
    record_type: "client_invoice",
    record_id: invoice.id,
    template: "client-invoice-resend",
    to_email: invoice.client_email,
    status: "sent",
    sent_at: now,
    // stripe_payment_url/total_inc_gst carried in `detail` specifically
    // so the NEXT resend's dedupe guard (above) has something to
    // compare against — see this route's own header comment.
    detail: {
      subject,
      attachment_omitted: attachmentTooLarge,
      stripe_payment_url: invoice.stripe_payment_url ?? null,
      total_inc_gst: invoice.total_inc_gst,
    },
  });

  // issued_at is left untouched — it's the FIRST-send timestamp
  // (preserved across any resend), same discipline .../send already
  // documents for itself. status stays 'sent' (it already was).
  return NextResponse.json({ invoice, attachment_omitted: attachmentTooLarge });
}

/** Same shape as .../send's buildInvoiceEmailHtml, but framed as an
 * update rather than a first notice — and mentions the "Pay online"
 * button when this resend is carrying a payment link for the first
 * time (invoice.stripe_payment_url set), since that's the whole point
 * of this round's recovery path. */
function buildResendEmailHtml(invoice: ClientInvoice, attachmentOmitted: boolean): string {
  const amount = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(invoice.total_inc_gst);

  const attachmentNote = attachmentOmitted
    ? `<p style="color:#313131;font-size:14px;">This invoice's PDF was too large to attach directly — please contact ${INVOICE_REPLY_TO} for a copy.</p>`
    : `<p style="color:#313131;font-size:14px;">Your updated tax invoice is attached as a PDF${invoice.stripe_payment_url ? ", now with a secure online payment link on the invoice itself" : ""}.</p>`;

  return `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;">
      <p style="letter-spacing:2px;text-transform:uppercase;font-size:11px;color:#A08C72;font-weight:bold;">RESLU</p>
      <h1 style="font-size:22px;color:#1A1A1A;margin:8px 0 16px;">Updated invoice ${invoice.invoice_number}</h1>
      <p style="color:#313131;font-size:14px;">Hi ${escapeHtml(invoice.client_name)},</p>
      <p style="color:#313131;font-size:14px;">
        Here's an updated copy of your RESLU tax invoice for <strong>${amount}</strong> (inc. GST), due within
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
