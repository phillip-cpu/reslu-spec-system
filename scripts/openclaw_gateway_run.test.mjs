import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentParams,
  extractChatReply,
  safeAgentEvent,
  validateGatewayUrl,
  validateRunInput,
} from "./openclaw_gateway_run.mjs";

test("Gateway transport is pinned to local loopback", () => {
  assert.equal(validateGatewayUrl("ws://127.0.0.1:18789"), "ws://127.0.0.1:18789/");
  assert.throws(() => validateGatewayUrl("ws://192.168.1.3:18789"), /loopback/);
  assert.throws(() => validateGatewayUrl("wss://example.com"), /loopback/);
  assert.throws(() => validateGatewayUrl("ws://user:secret@127.0.0.1:18789"), /Invalid/);
});

test("agent runs require a bounded stable session and idempotency key", () => {
  const input = validateRunInput({
    message: "Hello",
    agentId: "main",
    sessionKey: "reslu-conversation-v2-123",
    idempotencyKey: "job-123",
    timeoutSeconds: 180,
    thinking: "minimal",
    model: "openai/gpt-5.6-terra",
  });
  assert.equal(input.sessionKey, "reslu-conversation-v2-123");
  assert.equal(input.idempotencyKey, "job-123");
  assert.equal(input.model, "openai/gpt-5.6-terra");
  assert.throws(() => validateRunInput({ ...input, sessionKey: "../private" }), /session key/);
  assert.throws(() => validateRunInput({ ...input, timeoutSeconds: 0 }), /timeout/);
  assert.throws(() => validateRunInput({ ...input, model: "openai/gpt-5.6-terra --unsafe" }), /model override/);
});

test("Gateway agent params use native bounded images and an agent-qualified session", () => {
  const input = validateRunInput({
    message: "Read this screenshot",
    agentId: "marco",
    sessionKey: "reslu-conversation-v2-123",
    idempotencyKey: "job-vision-123",
    timeoutSeconds: 180,
    attachments: [{ fileName: "screen.png", mimeType: "image/png", content: "aGVsbG8=" }],
  });
  const params = buildAgentParams(input);
  assert.deepEqual(params.attachments, input.attachments);
  assert.equal(params.idempotencyKey, "job-vision-123");
  assert.equal(params.sessionKey, "agent:marco:reslu-conversation-v2-123");
  assert.throws(() => validateRunInput({
    ...input,
    attachments: [{ fileName: "brief.pdf", mimeType: "application/pdf", content: "aGVsbG8=" }],
  }), /Invalid image attachment/);
});

test("null image attachments mean no attachments", () => {
  const input = validateRunInput({
    message: "Check the account",
    agentId: "marco",
    sessionKey: "reslu-conversation-v2-123",
    idempotencyKey: "job-text-123",
    timeoutSeconds: 180,
    attachments: null,
  });
  assert.deepEqual(input.attachments, []);
});

test("Gateway events expose lifecycle and safe tool labels without arguments or results", () => {
  const tool = safeAgentEvent({
    type: "event",
    event: "agent",
    payload: {
      runId: "run-1",
      stream: "tool",
      data: {
        phase: "start",
        name: "calendar_search",
        toolCallId: "call-1",
        args: { private: "must not escape" },
        result: "must not escape",
      },
    },
  }, "run-1");
  assert.deepEqual(tool, {
    type: "tool",
    phase: "start",
    name: "calendar_search",
    tool_call_id: "call-1",
  });
  assert.equal(JSON.stringify(tool).includes("private"), false);
  assert.equal(JSON.stringify(tool).includes("must not escape"), false);

  assert.deepEqual(safeAgentEvent({
    type: "event",
    event: "agent",
    payload: { runId: "run-1", stream: "lifecycle", data: { phase: "finishing" } },
  }, "run-1"), { type: "lifecycle", phase: "finishing" });
});

test("only a matching final chat event becomes the canonical reply", () => {
  const final = safeAgentEvent({
    type: "event",
    event: "chat",
    payload: {
      runId: "run-1",
      state: "final",
      message: { content: [{ type: "text", text: "The final answer." }] },
    },
  }, "run-1");
  assert.deepEqual(final, { type: "final", reply: "The final answer." });
  assert.equal(safeAgentEvent({
    type: "event",
    event: "chat",
    payload: { runId: "older-run", state: "final", message: "stale" },
  }, "run-1"), null);
  assert.equal(extractChatReply({ content: [{ type: "tool_use", text: "hidden" }] }), null);
});
