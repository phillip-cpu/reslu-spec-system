import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailReplyQueueItem,
  buildLeadIntroductionQueueItem,
} from "./reply-routing.ts";

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

test("creates one stable proactive queue item for a lead introduction", () => {
  const email = {
    id: "email-456",
    from_addr: "referrer@example.com",
    subject: "Introduction - Jane and Sam",
    received_at: "2026-08-24T22:00:00Z",
  };

  assert.equal(buildLeadIntroductionQueueItem(email, false), null);
  assert.deepEqual(buildLeadIntroductionQueueItem(email, true), {
    kind: "lead_introduction",
    dedupe_key: "lead_introduction:email-456",
    source: "second-brain-triage",
    payload: {
      source_email_id: "email-456",
      from_addr: "referrer@example.com",
      subject: "Introduction - Jane and Sam",
      received_at: "2026-08-24T22:00:00Z",
    },
  });
});
