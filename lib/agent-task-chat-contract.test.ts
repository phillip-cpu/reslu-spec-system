import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const messagesRoute = readFileSync("app/api/conversations/[id]/messages/route.ts", "utf8");
const workspace = readFileSync("components/conversations/ConversationWorkspace.tsx", "utf8");
const bridge = readFileSync("scripts/conversation_agent_bridge.py", "utf8");

test("task chat messages are validated, scoped and routed to the owning agent", () => {
  assert.match(messagesRoute, /agent_task_id\?: unknown/);
  assert.match(messagesRoute, /\.eq\("id", agentTaskId\)[\s\S]*?\.eq\("conversation_id", id\)/);
  assert.match(messagesRoute, /linkedTaskOwner = linkedTask[\s\S]*?agent\.id === linkedTask\.owner_agent_id/);
  assert.match(messagesRoute, /agent_task_id: linkedTask\.id/);
});

test("each Agent Work card has its own visible task chat composer", () => {
  assert.match(workspace, />Task chat</);
  assert.match(workspace, /Ask a question or change the direction…/);
  assert.match(workspace, /agentTaskId: agentTask\?\.id/);
  assert.match(workspace, /taskMessagesById\.get\(selectedAgentTask\.id\)/);
});

test("the bridge supplies the exact task and its artifacts as bounded context", () => {
  assert.match(bridge, /def agent_task_chat_context\(/);
  assert.match(bridge, /"owner_agent_id": f"eq\.\{owner_agent_id\}"/);
  assert.match(bridge, /linked_task_context_json = bounded_json_data\(linked_task_context or \{\}, 30000\)/);
  assert.match(bridge, /AGENT_TASK_CONTEXT_JSON/);
  assert.match(bridge, /follow-up about only the assignment/);
});
