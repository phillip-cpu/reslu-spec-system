import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailReplyQueueItem } from "./reply-routing.ts";

test("creates one stable queue item only when triage expects a reply", () => {
  const email = {
    id: "email-123",
    from_addr: "phillip@reslu.com.au",
    subject: "Can you check Marco?",
    received_at: "2026-08-09T10:00:00Z",
  };

  assert.equal(buildEmailReplyQueueItem(email, false), null);
  assert.deepEqual(buildEmailReplyQueueItem(email, true), {
    kind: "email_reply_requested",
    dedupe_key: "email_reply_requested:email-123",
    source: "second-brain-triage",
    payload: {
      source_email_id: "email-123",
      from_addr: "phillip@reslu.com.au",
      subject: "Can you check Marco?",
      received_at: "2026-08-09T10:00:00Z",
    },
  });
});
