import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask, AgentTaskArtifact } from "../types/conversations.ts";
import { agentTaskBelongsInWorkPanel, visibleAgentWorkTasks } from "./agent-work-visibility.ts";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1", conversation_id: "conversation-1", requested_by: "user-1", owner_agent_id: "agent-1",
    source_message_id: null, source_call_id: null, delegated_by_agent_id: null, source_task_id: null,
    client_task_id: "client-1", title: "Routine research",
    objective: "Check the project record", requested_via: "voice", status: "running", model_tier: "standard",
    model_name: null, approval_state: "none", approval_note: null, result_summary: null, error: null, retry_count: 0,
    gateway_run_id: null, progress_label: null, progress_updated_at: null, cancellation_requested_at: null,
    claimed_at: null, completed_at: null, created_at: "2026-08-12T00:00:00Z", updated_at: "2026-08-12T00:00:00Z",
    events: [], artifacts: [], ...overrides,
  };
}

function artifact(overrides: Partial<AgentTaskArtifact> = {}): AgentTaskArtifact {
  return {
    id: "artifact-1", task_id: "task-1", artifact_key: "primary", kind: "text", title: "Result",
    content: {}, status: "draft", created_at: "2026-08-12T00:00:00Z", updated_at: "2026-08-12T00:00:00Z",
    ...overrides,
  };
}

test("completed work remains in the durable work history until the person clears it", () => {
  const completed = task({ status: "completed", artifacts: [artifact({ kind: "email_draft" })] });
  assert.equal(agentTaskBelongsInWorkPanel(completed), true);
  assert.deepEqual(visibleAgentWorkTasks([completed]), [completed]);
});

test("the work centre keeps routine progress as well as reviews and approvals", () => {
  assert.equal(agentTaskBelongsInWorkPanel(task()), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ title: "Draft client email" })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ status: "awaiting_approval" })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ artifacts: [artifact({ kind: "email_draft" })] })), true);
});

test("an already decided artifact remains visible without becoming a pending decision", () => {
  assert.equal(agentTaskBelongsInWorkPanel(task({
    status: "awaiting_approval",
    artifacts: [artifact({ status: "approved" })],
  })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({
    status: "awaiting_approval",
    artifacts: [artifact({ status: "approved" }), artifact({ id: "artifact-2", status: "draft" })],
  })), true);
});

test("attention and active work sort ahead of recent history", () => {
  const completed = task({ id: "completed", status: "completed", updated_at: "2026-08-13T00:00:00Z" });
  const running = task({ id: "running", status: "running", updated_at: "2026-08-12T00:00:00Z" });
  const approval = task({ id: "approval", status: "awaiting_approval", updated_at: "2026-08-11T00:00:00Z" });
  assert.deepEqual(visibleAgentWorkTasks([completed, running, approval]).map((item) => item.id), ["approval", "running", "completed"]);
});

test("structured tables and lists remain visible for glanceable review", () => {
  assert.equal(agentTaskBelongsInWorkPanel(task({ artifacts: [artifact({ content: { rows: [{ item: "Window" }] } })] })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ artifacts: [artifact({ content: { text: "- First\n- Second" } })] })), true);
});
