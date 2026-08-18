import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRealtimeSpecialistConsultRequest,
  resluSpecialistAgents,
} from "./realtime-specialist-consult.ts";

test("each voice owner can consult either of the other RESLU agents", () => {
  assert.deepEqual(resluSpecialistAgents("aria"), ["marco", "stuart"]);
  assert.deepEqual(resluSpecialistAgents("marco"), ["aria", "stuart"]);
  assert.deepEqual(resluSpecialistAgents("stuart"), ["aria", "marco"]);
});

test("specialist consult request keeps owner identity server-verifiable", () => {
  assert.deepEqual(parseRealtimeSpecialistConsultRequest({
    query: "  Ask Marco to challenge the commercial assumptions. ",
    owner_agent_slug: "aria",
    target_agent_slug: "marco",
    call_id: "call_123",
    tool_call_id: "tool_123",
    response_id: "response_123",
  }), {
    query: "Ask Marco to challenge the commercial assumptions.",
    ownerAgentSlug: "aria",
    targetAgentSlug: "marco",
    callId: "call_123",
    toolCallId: "tool_123",
    responseId: "response_123",
  });
});

test("specialist consult parser rejects arbitrary agents and unsafe ids", () => {
  assert.equal(parseRealtimeSpecialistConsultRequest({
    query: "Ask someone else",
    owner_agent_slug: "external",
    target_agent_slug: "marco",
    call_id: "call_123",
    tool_call_id: "tool_123",
  }), null);
  assert.equal(parseRealtimeSpecialistConsultRequest({
    query: "Ask Marco",
    owner_agent_slug: "aria",
    target_agent_slug: "marco",
    call_id: "not allowed",
    tool_call_id: "tool_123",
  }), null);
  assert.equal(parseRealtimeSpecialistConsultRequest({
    query: "Ask Aria",
    owner_agent_slug: "aria",
    target_agent_slug: "aria",
    call_id: "call_123",
    tool_call_id: "tool_123",
  }), null);
});
