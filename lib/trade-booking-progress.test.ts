import assert from "node:assert/strict";
import test from "node:test";
import { deriveTradeBookingProgress } from "./trade-booking-progress.ts";
import type { TradeBookingEmailEvidence } from "../types/round-grouped-trade-booking.ts";

const request = {
  status: "sent" as const,
  created_at: "2026-07-14T00:00:00.000Z",
  sent_at: null,
  viewed_at: null,
  responded_at: null,
};

const counts = { total: 2, accepted: 0, date_suggested: 0, outstanding: 2 };

function email(patch: Partial<TradeBookingEmailEvidence>): TradeBookingEmailEvidence {
  return {
    id: "email-1",
    to_email: "trade@example.com",
    status: "sent",
    scheduled_for: null,
    sent_at: "2026-07-14T00:01:00.000Z",
    created_at: "2026-07-14T00:01:00.000Z",
    provider_message_id: "provider-1",
    provider_status: null,
    provider_last_event_at: null,
    delivered_at: null,
    opened_at: null,
    clicked_at: null,
    bounced_at: null,
    failed_at: null,
    delivery_delayed_at: null,
    complained_at: null,
    suppressed_at: null,
    reason: null,
    ...patch,
  };
}

test("queued is distinct from sent", () => {
  const progress = deriveTradeBookingProgress({
    // Legacy rows stamped request.sent_at before the email pipeline
    // actually sent. The latest durable email attempt must win.
    request: { ...request, sent_at: "2026-07-14T00:00:30.000Z" },
    email: email({ status: "pending", sent_at: null, scheduled_for: "2026-07-14T21:30:00.000Z" }),
    counts,
  });
  assert.equal(progress.stage, "queued");
});

test("mail-server delivery is visible without claiming a human read it", () => {
  const progress = deriveTradeBookingProgress({
    request: { ...request, sent_at: "2026-07-14T00:01:00.000Z" },
    email: email({ delivered_at: "2026-07-14T00:02:00.000Z" }),
    counts,
  });
  assert.equal(progress.stage, "delivered");
  assert.match(progress.explanation, /does not prove it was read/i);
});

test("a booking-page view outranks a later bounce as engagement evidence", () => {
  const progress = deriveTradeBookingProgress({
    request: { ...request, viewed_at: "2026-07-14T00:03:00.000Z" },
    email: email({ bounced_at: "2026-07-14T00:04:00.000Z" }),
    counts,
  });
  assert.equal(progress.stage, "link_opened");
});

test("partial and complete responses outrank transport evidence", () => {
  const partial = deriveTradeBookingProgress({
    request,
    email: email({ failed_at: "2026-07-14T00:02:00.000Z" }),
    counts: { total: 2, accepted: 1, date_suggested: 0, outstanding: 1 },
  });
  assert.equal(partial.stage, "partial_response");

  const complete = deriveTradeBookingProgress({
    request: { ...request, status: "responded" },
    email: null,
    counts: { total: 2, accepted: 2, date_suggested: 0, outstanding: 0 },
  });
  assert.equal(complete.stage, "responded");
});
