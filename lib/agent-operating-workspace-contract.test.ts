import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("agent workspace is a first-class view in RESLU Messages", () => {
  const workspace = read("components/conversations/ConversationWorkspace.tsx");
  const operatingWorkspace = read("components/conversations/AgentOperatingWorkspace.tsx");
  assert.match(workspace, /AgentOperatingWorkspace/);
  assert.match(workspace, /agentWorkspaceOpen/);
  assert.match(operatingWorkspace, /Live computer/);
  assert.match(operatingWorkspace, /Take control/);
  assert.match(operatingWorkspace, /Message .* about this assignment/);
  assert.match(operatingWorkspace, /Nothing needs your approval/);
});

test("assignment messages are validated, owned and correlated through the runtime", () => {
  const route = read("app/api/conversations/[id]/messages/route.ts");
  const bridge = read("scripts/conversation_agent_bridge.py");
  assert.match(route, /agent_task_id/);
  assert.match(route, /Assignment not found/);
  assert.match(route, /linkedTaskOwner/);
  assert.match(bridge, /triggering_message_agent_task_id/);
  assert.match(bridge, /"agent_task_id": linked_agent_task_id/);
  assert.match(bridge, /\[Assignment:/);
});

test("takeover is never presented as available without runtime evidence", () => {
  const operatingWorkspace = read("components/conversations/AgentOperatingWorkspace.tsx");
  assert.match(operatingWorkspace, /computer\.controlUrl \?/);
  assert.match(operatingWorkspace, /runtime has not attached a secure takeover session/);
  assert.match(operatingWorkspace, /rather than inventing a computer view/);
});
