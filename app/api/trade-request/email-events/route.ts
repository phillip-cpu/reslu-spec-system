import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { verifyResendWebhookSignature } from "@/lib/resend-webhook";

export const runtime = "nodejs";

interface ResendEventBody {
  type?: unknown;
  created_at?: unknown;
  data?: { email_id?: unknown; id?: unknown };
}

const ACTIONABLE_DELIVERY_EVENTS = new Set([
  "email.bounced",
  "email.failed",
  "email.delivery_delayed",
  "email.complained",
  "email.suppressed",
]);

/**
 * Signed Resend delivery webhook. This route intentionally lives below
 * the existing public /api/trade-request/* boundary so the protected
 * authentication middleware remains untouched; the Svix signature is
 * the authentication boundary here.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
  }

  const eventId = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatureHeader = request.headers.get("svix-signature") ?? "";
  const rawBody = await request.text();

  if (
    !eventId ||
    !timestamp ||
    !signatureHeader ||
    !verifyResendWebhookSignature({
      body: rawBody,
      eventId,
      timestamp,
      signatureHeader,
      secret,
    })
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: ResendEventBody;
  try {
    body = JSON.parse(rawBody) as ResendEventBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = typeof body.type === "string" ? body.type : "";
  const providerMessageId =
    typeof body.data?.email_id === "string"
      ? body.data.email_id
      : typeof body.data?.id === "string"
        ? body.data.id
        : "";
  const eventAt = typeof body.created_at === "string" ? new Date(body.created_at) : null;

  if (!eventType || !providerMessageId || !eventAt || Number.isNaN(eventAt.getTime())) {
    return NextResponse.json({ error: "Event is missing required fields" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: matched, error } = await supabase.rpc("record_resend_email_event", {
    p_event_id: eventId,
    p_provider_message_id: providerMessageId,
    p_event_type: eventType,
    p_event_at: eventAt.toISOString(),
    p_payload: body,
  });

  if (error) {
    return NextResponse.json({ error: "Could not record event" }, { status: 500 });
  }

  // Phase 4: wake Aria immediately for real booking-delivery problems.
  // This queue write is internal only — it never resends the message or
  // changes a booking. Daily action sync independently creates/refreshes
  // one deduplicated Office task if the latest send is still unhealthy.
  let queueRaised = false;
  if (Number(matched ?? 0) > 0 && ACTIONABLE_DELIVERY_EVENTS.has(eventType)) {
    const { data: emailSend } = await supabase
      .from("email_sends")
      .select("id,record_type,record_id,to_email")
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    if (emailSend?.record_type === "trade_booking_request") {
      const { data: bookingRequest } = await supabase
        .from("trade_booking_requests")
        .select("id,project_id,status")
        .eq("id", emailSend.record_id)
        .maybeSingle();
      if (bookingRequest?.status === "sent") {
        const { data: queueRow, error: queueError } = await supabase
          .from("aria_queue")
          .upsert(
            {
              kind: "trade_reminder",
              payload: {
                action: "booking_email_delivery_exception",
                booking_request_id: bookingRequest.id,
                project_id: bookingRequest.project_id,
                email_send_id: emailSend.id,
                event_type: eventType,
                to_email: emailSend.to_email,
                instruction:
                  "Check the latest delivery evidence and prepare a safe internal follow-up. Do not resend or contact the trade without approval.",
              },
              dedupe_key: `trade_delivery:${emailSend.id}:${eventType}`,
              source: "resend-webhook",
            },
            { onConflict: "dedupe_key", ignoreDuplicates: true }
          )
          .select("id")
          .maybeSingle();
        if (queueError) {
          console.error("resend-webhook: could not raise delivery alert", queueError.message);
        } else {
          queueRaised = Boolean(queueRow);
        }
      }
    }
  }

  return NextResponse.json({
    received: true,
    matched: Number(matched ?? 0) > 0,
    queue_raised: queueRaised,
  });
}
