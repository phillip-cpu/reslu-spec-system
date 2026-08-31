import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask, ConversationMessage } from "../types/conversations.ts";
import {
  agentAssignmentView,
  filterAgentAssignments,
  latestAgentComputerState,
  messagesForAgentAssignment,
} from "./agent-operating-workspace.ts";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    conversation_id: "conversation-1",
    requested_by: "profile-1",
    owner_agent_id: "agent-1",
    source_message_id: null,
    source_call_id: null,
    client_task_id: "client-task-1",
    title: "Audit marketing",
    objective: "Find and execute the highest value repairs.",
    requested_via: "text",
    status: "running",
    model_tier: "standard",
    model_name: null,
    approval_state: "none",
    approval_note: null,
    result_summary: null,
    error: null,
    retry_count: 0,
    gateway_run_id: null,
    progress_label: "Reviewing evidence",
    progress_updated_at: null,
    cancellation_requested_at: null,
    claimed_at: null,
    completed_at: null,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    events: [],
    artifacts: [],
    ...overrides,
  };
}

test("assignments separate active work, decisions and history", () => {
  assert.equal(agentAssignmentView(task()), "active");
  assert.equal(agentAssignmentView(task({ status: "awaiting_approval" })), "waiting");
  assert.equal(agentAssignmentView(task({ status: "failed" })), "waiting");
  assert.equal(agentAssignmentView(task({ status: "completed" })), "done");
  assert.deepEqual(filterAgentAssignments([
    task({ id: "active" }),
    task({ id: "approval", status: "awaiting_approval" }),
  ], "waiting").map((entry) => entry.id), ["approval"]);
});

test("assignment chat is scoped by durable message metadata", () => {
  const messages = [
    { id: "message-1", metadata: { agent_task_id: "task-1" } },
    { id: "message-2", metadata: { agent_task_id: "task-2" } },
    { id: "message-3", metadata: {} },
  ] as ConversationMessage[];
  assert.deepEqual(messagesForAgentAssignment(messages, "task-1").map((message) => message.id), ["message-1"]);
});

test("computer state uses only runtime-supplied evidence", () => {
  const state = latestAgentComputerState(task({
    events: [{
      id: "event-1",
      task_id: "task-1",
      event_type: "progress",
      label: "Opened Google Ads",
      detail: null,
      metadata: {
        screenshot_url: "https://example.com/frame.png",
        control_url: "https://example.com/control",
        application: "Google Chrome",
        url: "https://ads.google.com",
        tool_name: "computer",
      },
      created_at: "2026-08-24T00:01:00Z",
    }],
  }));
  assert.deepEqual(state, {
    screenshotUrl: "https://example.com/frame.png",
    controlUrl: "https://example.com/control",
    application: "Google Chrome",
    location: "https://ads.google.com",
    tool: "computer",
  });
  assert.equal(latestAgentComputerState(task()).screenshotUrl, null);
});
