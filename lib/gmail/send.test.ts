import assert from "node:assert/strict";
import test from "node:test";
import { buildGmailMessageResource, buildRawMessage } from "./send.ts";

test("a follow-up carries the Gmail thread id and RFC reply headers", () => {
  const resource = buildGmailMessageResource({
    threadId: "gmail-thread-123",
    rawMessage: buildRawMessage({
      to: ["supplier@example.com"],
      cc: [],
      subject: "[RFQ-12345678] Quote request — Hone — Pool fence",
      body: "Following up.",
      attachments: [],
      replyHeaders: {
        inReplyTo: "<original-message@reslu.com.au>",
        references: "<older-message@reslu.com.au> <original-message@reslu.com.au>",
      },
    }),
  });

  assert.equal(resource.threadId, "gmail-thread-123");
  const decoded = Buffer.from(resource.raw, "base64url").toString("utf8");
  assert.match(decoded, /In-Reply-To: <original-message@reslu\.com\.au>/);
  assert.match(decoded, /References: <older-message@reslu\.com\.au> <original-message@reslu\.com\.au>/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
});

test("a new message does not invent thread or reply headers", () => {
  const resource = buildGmailMessageResource({
    rawMessage: buildRawMessage({
      to: ["supplier@example.com"],
      cc: ["accounts@example.com"],
      subject: "New request",
      body: "Please quote.",
      attachments: [],
    }),
  });

  assert.equal(resource.threadId, undefined);
  const decoded = Buffer.from(resource.raw, "base64url").toString("utf8");
  assert.doesNotMatch(decoded, /In-Reply-To:/);
  assert.doesNotMatch(decoded, /References:/);
  assert.match(decoded, /Cc: accounts@example\.com/);
});
