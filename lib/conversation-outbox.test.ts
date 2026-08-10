import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePendingConversationMessages,
  recoverPendingConversationMessage,
  sortPendingConversationMessages,
  type PendingConversationMessage,
} from "./conversation-outbox.ts";

function pending(overrides: Partial<PendingConversationMessage> = {}): PendingConversationMessage {
  return {
    clientMessageId: "11111111-1111-4111-8111-111111111111",
    ownerProfileId: "profile-1",
    conversationId: "conversation-1",
    body: "Hello Aria",
    source: "text",
    replyToId: null,
    attachmentIds: [],
    attachments: [],
    createdAt: "2026-08-10T10:00:00.000Z",
    status: "queued",
    error: null,
    retryable: true,
    ...overrides,
  };
}

test("a browser-close during a request recovers as a safe queued retry", () => {
  const recovered = recoverPendingConversationMessage(pending({ status: "sending", error: "interrupted" }));
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.error, null);
  assert.equal(recovered.retryable, true);
});

test("failed validation is preserved for explicit user retry", () => {
  const failed = pending({ status: "failed", retryable: false, error: "Message is too long" });
  assert.equal(recoverPendingConversationMessage(failed), failed);
});

test("queued messages retain creation order without mutating storage results", () => {
  const later = pending({ clientMessageId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-08-10T10:01:00.000Z" });
  const earlier = pending();
  const input = [later, earlier];
  const sorted = sortPendingConversationMessages(input);
  assert.deepEqual(sorted.map((entry) => entry.clientMessageId), [earlier.clientMessageId, later.clientMessageId]);
  assert.deepEqual(input.map((entry) => entry.clientMessageId), [later.clientMessageId, earlier.clientMessageId]);
});

test("newer in-memory state wins when storage hydration races with a send", () => {
  const stored = pending({ status: "queued" });
  const sending = pending({ status: "sending" });
  const merged = mergePendingConversationMessages([stored], [sending]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "sending");
});

test("older stored entries recover with an explicit empty reply target", () => {
  const legacy = { ...pending() } as Partial<PendingConversationMessage>;
  delete legacy.replyToId;
  assert.equal(recoverPendingConversationMessage(legacy as PendingConversationMessage).replyToId, null);
});
