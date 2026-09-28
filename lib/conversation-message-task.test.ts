import assert from "node:assert/strict";
import test from "node:test";
import { conversationMessageTask, matchesConversationMessageTask } from "./conversation-message-task.ts";
import { parseStartAgentTaskRequest, taskIntentMatches } from "./agent-tasks.ts";
import type { ConversationMessage, ConversationParticipant } from "../types/conversations";

const human: ConversationParticipant = { id: "owner", type: "human", display_name: "Owner", avatar_url: null };
const agent: ConversationParticipant = { id: "stuart-id", type: "agent", agent_slug: "stuart", display_name: "Stuart", avatar_url: null };
const message: ConversationMessage = {
  id: "message-id", conversation_id: "conversation-id", client_message_id: null,
  author_profile_id: human.id, author_agent_id: null, author: human,
  kind: "text", body: "Prepare the remittance review.\nStop before approval or execution.",
  metadata: {}, attachments: [], reactions: [], reply_to_id: null,
  created_at: "2026-09-28T12:17:00Z", edited_at: null, deleted_at: null,
  pinned_at: null, pinned_by: null,
};
const request = (value = message, participants = [human, agent]) => conversationMessageTask(value, "conversation-id", human.id, participants);

test("own text creates a valid task intent with stable retry identity and unchanged objective", () => {
  const body = request()!;
  assert.deepEqual(body, request());
  assert.equal(body.objective, message.body);
  assert.equal(body.source_message_id, message.id);
  const parsed = parseStartAgentTaskRequest(body)!;
  assert.ok(parsed);
  assert.equal(taskIntentMatches({ title: body.title, objective: body.objective, owner_agent_id: agent.id, model_tier: "standard" }, parsed, agent.id), true);
  const edited = parseStartAgentTaskRequest(request({ ...message, body: "Different work" }))!;
  assert.equal(edited.clientTaskId, parsed.clientTaskId);
  assert.equal(taskIntentMatches({ title: body.title, objective: body.objective, owner_agent_id: agent.id, model_tier: "standard" }, edited, agent.id), false);
});

test("forwarded content, agent output, other authors and task chat cannot become task instructions", () => {
  for (const changed of [
    { metadata: { source: "forward" } }, { metadata: { source: "agent_consultation" } },
    { metadata: { source: "agent_task" } }, { metadata: { agent_task_id: "existing" } },
    { author_profile_id: "someone-else" }, { author_agent_id: agent.id, author: agent },
    { conversation_id: "another-conversation" }, { deleted_at: "2026-09-28T12:18:00Z" },
    { kind: "system" as const }, { body: " " }, { body: "x".repeat(20_001) },
  ]) assert.equal(request({ ...message, ...changed }), null);
  assert.equal(request({ ...message, attachments: [{ id: "source" } as ConversationMessage["attachments"][number]] }), null);
});

test("task recipient must be an unambiguous current conversation agent", () => {
  assert.equal(request(message, [human]), null);
  assert.equal(request(message, [human, agent, { ...agent, id: "marco-id", agent_slug: "marco" }]), null);
  assert.equal(request(message, [human, { ...agent, agent_slug: undefined }]), null);
  assert.equal(request(message, [agent]), null);
});

test("server rejects forged and stale source-bound task intent", () => {
  const parsed = parseStartAgentTaskRequest(request())!;
  const matches = (value = parsed, canonical = message) => matchesConversationMessageTask(value, canonical, "conversation-id", human.id, [human, agent]);
  assert.equal(matches(), true);
  for (const change of [
    { objective: "Record receipts now" }, { title: "Different" }, { clientTaskId: "forged" },
    { sourceMessageId: "other" }, { sourceMessageTask: undefined }, { agentSlug: "marco" as const },
    { sourceCallId: "call" }, { requestedVia: "voice" as const }, { modelTier: "strong" as const },
  ]) assert.equal(matches({ ...parsed, ...change }), false);
  for (const change of [
    { body: "Edited after rendering" }, { author_profile_id: "other" }, { author_agent_id: agent.id },
    { deleted_at: "2026-09-28T13:00:00Z" }, { metadata: { source: "forward" } },
    { metadata: { source: "agent_consultation" } }, { metadata: { task_id: "task" } },
    { attachments: [{ id: "uploaded-or-forwarded" } as ConversationMessage["attachments"][number]] },
  ]) assert.equal(matches(parsed, { ...message, ...change }), false);
});

test("source-bound mode requires a canonical text message without changing ordinary task parsing", () => {
  const raw = request()!;
  for (const change of [
    { source_message_id: null }, { source_message_task: "true" }, { source_message_task: false },
    { source_call_id: "call" }, { requested_via: "voice" },
  ]) assert.equal(parseStartAgentTaskRequest({ ...raw, ...change }), null);
  const ordinary = parseStartAgentTaskRequest({ ...raw, source_message_task: undefined, source_message_id: null });
  assert.ok(ordinary);
  assert.equal("sourceMessageTask" in ordinary, false);
});
