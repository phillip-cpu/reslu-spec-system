import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("agent work is integrated into chat as one progressive work centre", () => {
  const workspace = read("components/conversations/ConversationWorkspace.tsx");
  assert.doesNotMatch(workspace, /AgentOperatingWorkspace/);
  assert.doesNotMatch(workspace, /agentWorkspaceOpen/);
  assert.match(workspace, /Work in this conversation/);
  assert.match(workspace, /Live computer/);
  assert.match(workspace, /Take control/);
  assert.match(workspace, /Ask or steer in chat/);
  assert.match(workspace, /agent_task_id: entry\.agentTaskId/);
  assert.match(workspace, /Steering \{composerAgentTask\.owner_agent\?\.display_name/);
});

test("assignment messages are validated, safely routed and correlated through the runtime", () => {
  const route = read("app/api/conversations/[id]/messages/route.ts");
  const workspace = read("components/conversations/ConversationWorkspace.tsx");
  const bridge = read("scripts/conversation_agent_bridge.py");
  assert.match(route, /agent_task_id/);
  assert.match(route, /Assignment not found/);
  assert.match(route, /linkedTaskOwner/);
  assert.doesNotMatch(route, /Assignment owner is not in this conversation/);
  assert.match(workspace, /targetAgent: agentTask\?\.owner_agent\?\.agent_slug/);
  assert.match(workspace, /agentTaskId: agentTask\?\.id/);
  assert.match(bridge, /triggering_message_agent_task_id/);
  assert.match(bridge, /"agent_task_id": linked_agent_task_id/);
  assert.match(bridge, /\[Assignment:/);
});

test("takeover is never presented as available without runtime evidence", () => {
  const workspace = read("components/conversations/ConversationWorkspace.tsx");
  assert.match(workspace, /computer\.controlUrl &&/);
  assert.match(workspace, /href=\{computer\.controlUrl\}/);
});
