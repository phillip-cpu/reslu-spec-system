import type {
  TradeBookingEmailEvidence,
  TradeBookingProgress,
  TradeBookingRequestRow,
  TradeBookingRequestStage,
  TradeBookingLineCounts,
} from "@/types/round-grouped-trade-booking";

/**
 * One canonical interpretation of a grouped trade booking. Both the
 * project-board summary and the full request detail use this helper so
 * "sent", "delivered" and "responded" cannot mean different things on
 * different screens.
 */
export function deriveTradeBookingProgress({
  request,
  email,
  counts,
}: {
  request: Pick<
    TradeBookingRequestRow,
    "status" | "created_at" | "sent_at" | "viewed_at" | "responded_at"
  >;
  email: TradeBookingEmailEvidence | null;
  counts: TradeBookingLineCounts;
}): TradeBookingProgress {
  let stage: TradeBookingRequestStage;

  if (request.status === "responded" || (counts.total > 0 && counts.outstanding === 0)) {
    stage = "responded";
  } else if (counts.accepted + counts.date_suggested > 0) {
    stage = "partial_response";
  } else if (request.viewed_at) {
    stage = "link_opened";
  } else if (email?.bounced_at || email?.failed_at || email?.suppressed_at) {
    stage = "delivery_problem";
  } else if (email?.clicked_at) {
    stage = "email_link_clicked";
  } else if (email?.opened_at) {
    stage = "email_open_detected";
  } else if (email?.delivered_at) {
    stage = "delivered";
  } else if (email?.status === "pending") {
    stage = "queued";
  } else if (email?.status === "sent" || request.sent_at) {
    stage = "sent";
  } else {
    stage = "not_sent";
  }

  const copy: Record<
    TradeBookingRequestStage,
    Pick<TradeBookingProgress, "label" | "explanation" | "tone">
  > = {
    not_sent: {
      label: "Email not sent",
      explanation: email?.reason ?? "The booking exists, but no email has left RESLU yet.",
      tone: "danger",
    },
    queued: {
      label: "Queued to send",
      explanation: email?.scheduled_for
        ? "The email is waiting for the next permitted sending window."
        : "The email is queued for another delivery attempt.",
      tone: "warning",
    },
    sent: {
      label: "Sent — delivery pending",
      explanation: "Resend accepted the email. Mail-server delivery has not been confirmed yet.",
      tone: "neutral",
    },
    delivered: {
      label: "Delivered to mail server",
      explanation: "The recipient's mail server accepted the email. This does not prove it was read.",
      tone: "positive",
    },
    email_open_detected: {
      label: "Email open detected",
      explanation: "An open was detected, although privacy tools can make open tracking approximate.",
      tone: "positive",
    },
    email_link_clicked: {
      label: "Booking link clicked",
      explanation: "The email's booking link was clicked; the response page has not yet recorded a full load.",
      tone: "positive",
    },
    link_opened: {
      label: "Booking opened",
      explanation: "The public booking page was opened. A response is still outstanding.",
      tone: "positive",
    },
    partial_response: {
      label: "Partly confirmed",
      explanation: `${counts.accepted + counts.date_suggested} of ${counts.total} booking line${counts.total === 1 ? "" : "s"} answered.`,
      tone: "warning",
    },
    responded: {
      label: "Trade responded",
      explanation: counts.date_suggested > 0
        ? `All lines answered; ${counts.date_suggested} date suggestion${counts.date_suggested === 1 ? "" : "s"} need review.`
        : "Every booking line has been confirmed.",
      tone: counts.date_suggested > 0 ? "warning" : "positive",
    },
    delivery_problem: {
      label: "Delivery problem",
      explanation: email?.bounced_at
        ? "The receiving mail server rejected or bounced this email."
        : email?.suppressed_at
          ? "Resend suppressed this email before delivery."
          : "The email provider reported a delivery failure.",
      tone: "danger",
    },
  };

  return { stage, ...copy[stage] };
}

export function countTradeBookingLines(
  lines: { line_status: string | null }[]
): TradeBookingLineCounts {
  const accepted = lines.filter((line) => line.line_status === "accepted").length;
  const date_suggested = lines.filter((line) => line.line_status === "date_suggested").length;
  const total = lines.length;
  return {
    total,
    accepted,
    date_suggested,
    outstanding: Math.max(0, total - accepted - date_suggested),
  };
}

/** Convert the deliberately ungenerated Supabase row into the small,
 * stable evidence shape the UI is allowed to depend on. */
export function tradeBookingEmailEvidenceFromRow(
  row: Record<string, unknown> | null | undefined
): TradeBookingEmailEvidence | null {
  if (!row || typeof row.id !== "string") return null;
  const detail =
    row.detail && typeof row.detail === "object"
      ? (row.detail as Record<string, unknown>)
      : {};
  const stringOrNull = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

  return {
    id: row.id,
    to_email: typeof row.to_email === "string" ? row.to_email : "",
    status:
      row.status === "sent" || row.status === "skipped" ? row.status : "pending",
    scheduled_for: stringOrNull(row.scheduled_for),
    sent_at: stringOrNull(row.sent_at),
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    provider_message_id: stringOrNull(row.provider_message_id),
    provider_status: stringOrNull(row.provider_status),
    provider_last_event_at: stringOrNull(row.provider_last_event_at),
    delivered_at: stringOrNull(row.delivered_at),
    opened_at: stringOrNull(row.opened_at),
    clicked_at: stringOrNull(row.clicked_at),
    bounced_at: stringOrNull(row.bounced_at),
    failed_at: stringOrNull(row.failed_at),
    delivery_delayed_at: stringOrNull(row.delivery_delayed_at),
    complained_at: stringOrNull(row.complained_at),
    suppressed_at: stringOrNull(row.suppressed_at),
    reason: stringOrNull(detail.reason),
  };
}
