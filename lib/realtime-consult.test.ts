import assert from "node:assert/strict";
import test from "node:test";
import { authorizedConversationAgent } from "./conversation-access.ts";
import { consultMessageMatchesIntent, consultStatus, parseRealtimeConsultRequest } from "./realtime-consult.ts";
import type { ConversationParticipant } from "../types/conversations.ts";

const participants: ConversationParticipant[] = [
  { id: "user-1", type: "human", display_name: "Phillip", avatar_url: null, is_self: true },
  { id: "agent-1", type: "agent", display_name: "Aria", avatar_url: null, agent_slug: "aria", role_label: "Studio assistant" },
];

test("conversation authorization requires both membership and the requested agent", () => {
  assert.equal(authorizedConversationAgent(participants, "user-1", "aria")?.id, "agent-1");
  assert.equal(authorizedConversationAgent(participants, "outsider", "aria"), null);
  assert.equal(authorizedConversationAgent(participants, "user-1", "marco"), null);
});

test("consult routing accepts bounded canonical provider ids and agent slugs", () => {
  assert.deepEqual(parseRealtimeConsultRequest({
    query: " What is happening with the Norwood project? ",
    agent_slug: "aria",
    call_id: "call-123",
    tool_call_id: "tool_123",
    response_id: "resp_123",
  }), {
    query: "What is happening with the Norwood project?",
    agentSlug: "aria",
    callId: "call-123",
    toolCallId: "tool_123",
    responseId: "resp_123",
  });
  assert.equal(parseRealtimeConsultRequest({ query: "hello", agent_slug: "bruno" }), null);
  assert.equal(parseRealtimeConsultRequest({ query: "hello", agent_slug: "aria", call_id: "bad id", tool_call_id: "tool" }), null);
});

test("a job is complete only when its canonical agent message exists", () => {
  assert.equal(consultStatus("processing", false), "pending");
  assert.equal(consultStatus("done", false), "pending");
  assert.equal(consultStatus("done", true), "done");
  assert.equal(consultStatus("cancelled", true), "cancelled");
});

test("a retried realtime tool call must match the entire canonical voice intent", () => {
  const intent = {
    query: "What is on my list today?",
    agentSlug: "aria" as const,
    callId: "call-123",
    toolCallId: "tool-123",
    responseId: "response-123",
  };
  const message = {
    body: intent.query,
    metadata: {
      source: "voice",
      transport: "openai_realtime_webrtc",
      realtime_call_id: intent.callId,
      realtime_tool_call_id: intent.toolCallId,
      realtime_response_id: intent.responseId,
      target_agent_slugs: [intent.agentSlug],
    },
  };
  assert.equal(consultMessageMatchesIntent(message, intent), true);
  assert.equal(consultMessageMatchesIntent({ ...message, body: "Delete the project" }, intent), false);
  assert.equal(consultMessageMatchesIntent({
    ...message,
    metadata: { ...message.metadata, target_agent_slugs: ["marco"] },
  }, intent), false);
  assert.equal(consultMessageMatchesIntent({
    ...message,
    metadata: { ...message.metadata, realtime_response_id: "response-other" },
  }, intent), false);
  assert.equal(consultMessageMatchesIntent({ ...message, metadata: [] }, intent), false);
});
