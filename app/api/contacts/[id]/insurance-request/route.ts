import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  normaliseInsuranceRequestKinds,
  renderInsuranceRequestEmail,
} from "@/lib/insurance-requests";
import { sendViaResend } from "@/lib/resend";
import { reportError } from "@/lib/report-error";
import type { SendInsuranceRequestInput } from "@/types/insurance-requests";

export const runtime = "nodejs";

const REQUEST_FROM = "Aria — RESLU <aria@reslu.com.au>";
const REQUEST_REPLY_TO = "phillip@reslu.com.au";

function formatExpiry(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * POST /api/contacts/[id]/insurance-request
 *
 * Sends the contact a new secure document-upload request. Any older
 * still-open request is cancelled only after the new email has been
 * accepted by Resend, so a transport failure never destroys the
 * contact's previous working link.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contactId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as SendInsuranceRequestInput;
  const kinds = normaliseInsuranceRequestKinds(body.kinds);
  if (kinds.length === 0) {
    return NextResponse.json(
      { error: "Choose at least one document to request." },
      { status: 400 }
    );
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id,company,contact_name,email")
    .eq("id", contactId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  if (!contact.email?.trim()) {
    return NextResponse.json(
      { error: "Add an email address to this contact before sending a request." },
      { status: 400 }
    );
  }

  // Guard against accidental double-clicks or two open browser tabs
  // sending the same request seconds apart.
  const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: recent } = await supabase
    .from("contact_document_requests")
    .select("id")
    .eq("contact_id", contactId)
    .in("status", ["requested", "opened"])
    .gte("created_at", twoMinutesAgo)
    .limit(1)
    .maybeSingle();
  if (recent) {
    return NextResponse.json(
      { error: "A request was just sent to this contact. Please wait before sending it again." },
      { status: 409 }
    );
  }

  const { data: documentRequest, error: createError } = await supabase
    .from("contact_document_requests")
    .insert({
      contact_id: contactId,
      requested_kinds: kinds,
      to_email: contact.email.trim(),
      created_by: user.id,
    })
    .select(
      "id,token,requested_kinds,to_email,status,requested_at,sent_at,opened_at,completed_at,expires_at"
    )
    .single();
  if (createError || !documentRequest) {
    return NextResponse.json(
      { error: createError?.message ?? "Could not create the document request." },
      { status: 500 }
    );
  }

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "https://spec.reslu.com.au"
  ).replace(/\/+$/, "");
  const uploadUrl = `${appUrl}/insurance/${documentRequest.token}`;
  const greetingName = contact.contact_name?.trim().split(/\s+/)[0] || contact.company;
  const subject = `RESLU · insurance documents requested — ${contact.company}`;
  const html = renderInsuranceRequestEmail({
    greetingName,
    company: contact.company,
    kinds,
    uploadUrl,
    expiresLabel: formatExpiry(documentRequest.expires_at),
  });

  try {
    const sendResult = await sendViaResend({
      from: REQUEST_FROM,
      to: [contact.email.trim()],
      replyTo: REQUEST_REPLY_TO,
      subject,
      html,
    });
    if (sendResult.skipped) {
      await supabase.from("contact_document_requests").delete().eq("id", documentRequest.id);
      return NextResponse.json(
        { error: "Email sending is not configured." },
        { status: 503 }
      );
    }

    const sentAt = new Date().toISOString();
    const [{ data: updated, error: updateError }] = await Promise.all([
      supabase
        .from("contact_document_requests")
        .update({
          sent_at: sentAt,
          provider_message_id: sendResult.providerMessageId ?? null,
        })
        .eq("id", documentRequest.id)
        .select(
          "id,requested_kinds,to_email,status,requested_at,sent_at,opened_at,completed_at,expires_at"
        )
        .single(),
      supabase
        .from("contact_document_requests")
        .update({ status: "cancelled" })
        .eq("contact_id", contactId)
        .in("status", ["requested", "opened"])
        .neq("id", documentRequest.id),
      supabase
        .from("contacts")
        .update({ insurance_required: true })
        .eq("id", contactId),
    ]);
    if (updateError || !updated) {
      await reportError(
        "insurance-request-status",
        updateError ?? new Error("Request email sent but status could not be updated")
      );
    }

    const { error: logError } = await supabase.from("email_sends").insert({
      record_type: "contact_document_request",
      record_id: documentRequest.id,
      template: "insurance-document-request",
      to_email: contact.email.trim(),
      status: "sent",
      sent_at: sentAt,
      provider_message_id: sendResult.providerMessageId ?? null,
      detail: {
        subject,
        contact_id: contactId,
        requested_kinds: kinds,
        request_link: uploadUrl,
      },
    });
    if (logError) await reportError("insurance-request-email-log", logError);

    return NextResponse.json({
      request:
        updated ??
        ({
          ...documentRequest,
          sent_at: sentAt,
        } as typeof documentRequest),
    });
  } catch (error) {
    await supabase.from("contact_document_requests").delete().eq("id", documentRequest.id);
    await reportError("insurance-request-send", error);
    return NextResponse.json(
      { error: "The request email could not be sent. Please try again." },
      { status: 502 }
    );
  }
}
