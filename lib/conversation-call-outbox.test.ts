import assert from "node:assert/strict";
import test from "node:test";
import {
  listPendingConversationCallEnds,
  removePendingConversationCallEnd,
  savePendingConversationCallEnd,
  type PendingConversationCallEnd,
} from "./conversation-call-outbox.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const callId = "44444444-4444-4444-8444-444444444444";

function pending(overrides: Partial<PendingConversationCallEnd> = {}): PendingConversationCallEnd {
  return {
    ownerProfileId: owner,
    conversationId,
    callId,
    createdAt: "2026-08-11T01:00:00.000Z",
    voiceMetrics: [{ turn: 1, outcome: "spoken" }],
    ...overrides,
  };
}

test("a call end stays on device until the canonical record is acknowledged", () => {
  const storage = new MemoryStorage();
  savePendingConversationCallEnd(pending(), storage);
  assert.deepEqual(listPendingConversationCallEnds(owner, storage), [pending()]);
  removePendingConversationCallEnd(owner, callId, storage);
  assert.deepEqual(listPendingConversationCallEnds(owner, storage), []);
});

test("saving the same call end replaces rather than duplicates the intent", () => {
  const storage = new MemoryStorage();
  savePendingConversationCallEnd(pending(), storage);
  const updated = pending({ createdAt: "2026-08-11T01:00:05.000Z", voiceMetrics: [] });
  savePendingConversationCallEnd(updated, storage);
  assert.deepEqual(listPendingConversationCallEnds(owner, storage), [updated]);
});

test("pending call ends are isolated by signed-in profile", () => {
  const storage = new MemoryStorage();
  savePendingConversationCallEnd(pending(), storage);
  savePendingConversationCallEnd(pending({
    ownerProfileId: otherOwner,
    callId: "55555555-5555-4555-8555-555555555555",
  }), storage);
  assert.equal(listPendingConversationCallEnds(owner, storage).length, 1);
  assert.equal(listPendingConversationCallEnds(otherOwner, storage).length, 1);
});
