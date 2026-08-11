import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRealtimeAgentTaskRequest,
  parseStartAgentTaskRequest,
  realtimeTaskAcknowledgement,
  taskIntentMatches,
} from "./agent-tasks.ts";

test("parses a durable task and defaults normal work to the standard model", () => {
  const request = parseStartAgentTaskRequest({
    client_task_id: "task_123",
    agent_slug: "aria",
    title: "Draft client email",
    objective: "Draft an email to Jane confirming Friday's design meeting.",
  });
  assert.ok(request);
  assert.equal(request.modelTier, "standard");
  assert.equal(request.requestedVia, "text");
});

test("realtime tasks inherit the provider call id and require a canonical call", () => {
  const request = parseRealtimeAgentTaskRequest({
    tool_call_id: "call_abc-123",
    call_id: "8f855b47-8cd5-4c94-b288-280da7ea8f92",
    response_id: "resp_123",
    agent_slug: "marco",
    title: "Review specification",
    objective: "Review the wet-area specification and report conflicts.",
    model_tier: "strong",
  });
  assert.ok(request);
  assert.equal(request.clientTaskId, "call_abc-123");
  assert.equal(request.requestedVia, "voice");
  assert.equal(request.modelTier, "strong");
  assert.equal(parseRealtimeAgentTaskRequest({ ...request, tool_call_id: "bad id", call_id: null }), null);
});

test("idempotent retries must describe exactly the same work", () => {
  const requested = parseStartAgentTaskRequest({
    client_task_id: "task_123",
    agent_slug: "aria",
    title: "Prepare report",
    objective: "Prepare the report.",
    model_tier: "fast",
  });
  assert.ok(requested);
  assert.equal(taskIntentMatches({
    title: "Prepare report",
    objective: "Prepare the report.",
    owner_agent_id: "agent-1",
    model_tier: "fast",
  }, requested, "agent-1"), true);
  assert.equal(taskIntentMatches({
    title: "Prepare report",
    objective: "Prepare a different report.",
    owner_agent_id: "agent-1",
    model_tier: "fast",
  }, requested, "agent-1"), false);
});

test("voice acknowledgement makes the persistence boundary explicit", () => {
  assert.match(realtimeTaskAcknowledgement("Draft client email"), /keep talking or end the call/i);
  assert.match(realtimeTaskAcknowledgement("Draft client email"), /post the result here/i);
});
