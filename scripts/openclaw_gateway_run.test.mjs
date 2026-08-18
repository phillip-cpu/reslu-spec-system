import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentParams,
  extractChatReply,
  extractDurableRunReply,
  extractDurableRunResult,
  runGatewayAgent,
  safeAgentEvent,
  safeOpenClawUsage,
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

test("final events expose bounded content-free OpenClaw usage only", () => {
  const message = {
    content: [{ type: "text", text: "Done." }],
    provider: "openai",
    model: "gpt-5.6-terra",
    usage: {
      input: 120,
      output: 8,
      cacheRead: 20,
      cacheWrite: 0,
      totalTokens: 148,
      cost: { total: 0.001234567891, private: "do not retain" },
      prompt: "private",
    },
  };
  const usage = safeOpenClawUsage(message);
  assert.deepEqual(usage, {
    schema_version: 1,
    provider: "openai",
    model: "gpt-5.6-terra",
    input_tokens: 120,
    output_tokens: 8,
    cache_read_tokens: 20,
    cache_write_tokens: 0,
    total_tokens: 148,
    cost_usd: 0.00123457,
  });
  const final = safeAgentEvent({
    type: "event",
    event: "chat",
    payload: { runId: "run-usage", state: "final", message },
  }, "run-usage");
  assert.deepEqual(final, { type: "final", reply: "Done.", usage });
  assert.equal(JSON.stringify(final).includes("private"), false);
  assert.equal(safeOpenClawUsage({ ...message, model: "bad model" }), null);
  assert.equal(safeOpenClawUsage({ ...message, usage: { ...message.usage, input: 1_000_000_001 } }), null);
});

test("durable history recovers only the reply to the exact accepted prompt", () => {
  const acceptedAt = 10_000;
  const history = {
    messages: [
      { role: "user", timestamp: 2_000, content: "An older prompt" },
      { role: "assistant", timestamp: 3_000, content: "An older answer" },
      { role: "user", timestamp: 9_500, content: "The current prompt" },
      { role: "toolResult", timestamp: 10_100, content: "private tool output" },
      { role: "assistant", timestamp: 12_000, content: [{ type: "text", text: "The durable answer" }] },
    ],
  };
  assert.equal(extractDurableRunReply(history, "The current prompt", acceptedAt), "The durable answer");
  assert.equal(extractDurableRunReply(history, "A different prompt", acceptedAt), null);
});

test("durable history recovery retains only safe runtime usage", () => {
  const result = extractDurableRunResult({ messages: [
    { role: "user", timestamp: 9_500, content: "Current" },
    {
      role: "assistant",
      timestamp: 10_500,
      content: "Answer",
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    },
  ] }, "Current", 10_000);
  assert.equal(result?.reply, "Answer");
  assert.equal(result?.usage?.total_tokens, 12);
});

test("durable history rejects stale and non-visible assistant output", () => {
  assert.equal(extractDurableRunReply({ messages: [
    { role: "user", timestamp: 2_000, content: "Current" },
    { role: "assistant", timestamp: 2_100, content: "Stale answer" },
  ] }, "Current", 10_000), null);

  assert.equal(extractDurableRunReply({ messages: [
    { role: "user", timestamp: 9_500, content: "Current" },
    { role: "assistant", timestamp: 10_100, content: [{ type: "reasoning", text: "hidden" }] },
  ] }, "Current", 10_000), null);
});

test("a lifecycle end recovers from durable history without rerunning the agent", async () => {
  const sentMethods = [];
  const socket = {
    readyState: WebSocket.OPEN,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(raw) {
      const request = JSON.parse(raw);
      sentMethods.push(request.method);
      if (request.method === "connect") {
        setImmediate(() => this.onmessage({ data: JSON.stringify({ type: "res", id: request.id, ok: true }) }));
      } else if (request.method === "agent") {
        setImmediate(() => {
          this.onmessage({ data: JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: { runId: "run-current", sessionKey: request.params.sessionKey, acceptedAt: 10_000 },
          }) });
          this.onmessage({ data: JSON.stringify({
            type: "event",
            event: "agent",
            payload: { runId: "run-current", stream: "lifecycle", data: { phase: "end" } },
          }) });
        });
      } else if (request.method === "chat.history") {
        setImmediate(() => this.onmessage({ data: JSON.stringify({
          type: "res",
          id: request.id,
          ok: true,
          payload: { messages: [
            { role: "user", timestamp: 9_500, content: "Recover this exact turn" },
            { role: "assistant", timestamp: 10_500, content: "Recovered once" },
          ] },
        }) }));
      }
    },
    close() { this.readyState = WebSocket.CLOSED; },
  };

  const run = runGatewayAgent(validateRunInput({
    message: "Recover this exact turn",
    agentId: "marco",
    sessionKey: "reslu-transport-test",
    idempotencyKey: "transport-test-1",
    timeoutSeconds: 10,
  }), { websocket: socket, token: "test-token", emit() {} });
  socket.onmessage({ data: JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }) });

  assert.equal(await run, "Recovered once");
  assert.equal(sentMethods.filter((method) => method === "agent").length, 1);
  assert.equal(sentMethods.filter((method) => method === "chat.history").length, 1);
});
