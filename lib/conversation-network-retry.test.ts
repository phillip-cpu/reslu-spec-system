import assert from "node:assert/strict";
import test from "node:test";
import { BoundedRequestTimeoutError } from "./bounded-request.ts";
import {
  isTransientConversationNetworkError,
  retrySameConversationIntent,
} from "./conversation-network-retry.ts";

test("a lost response retries the same caller-owned intent", async () => {
  const intent = { toolCallId: "call_same_intent" };
  const observed: string[] = [];
  const result = await retrySameConversationIntent(async () => {
    observed.push(intent.toolCallId);
    if (observed.length === 1) throw new BoundedRequestTimeoutError();
    return "accepted";
  });
  assert.equal(result, "accepted");
  assert.deepEqual(observed, ["call_same_intent", "call_same_intent"]);
});

test("ordinary network failures retry but caller cancellation never does", async () => {
  let networkAttempts = 0;
  await assert.rejects(
    retrySameConversationIntent(async () => {
      networkAttempts += 1;
      throw new TypeError("network unavailable");
    }),
    TypeError,
  );
  assert.equal(networkAttempts, 2);

  let cancellationAttempts = 0;
  await assert.rejects(
    retrySameConversationIntent(async () => {
      cancellationAttempts += 1;
      throw new DOMException("Aborted", "AbortError");
    }),
    { name: "AbortError" },
  );
  assert.equal(cancellationAttempts, 1);
  assert.equal(isTransientConversationNetworkError(new DOMException("Aborted", "AbortError")), false);
});

test("conversation retries are strictly bounded", async () => {
  await assert.rejects(() => retrySameConversationIntent(async () => "ok", 0), /between 1 and 3/);
  await assert.rejects(() => retrySameConversationIntent(async () => "ok", 4), /between 1 and 3/);
});
