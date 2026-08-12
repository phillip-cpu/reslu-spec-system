import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask, AgentTaskArtifact } from "../types/conversations.ts";
import { agentTaskBelongsInWorkPanel, visibleAgentWorkTasks } from "./agent-work-visibility.ts";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1", conversation_id: "conversation-1", requested_by: "user-1", owner_agent_id: "agent-1",
    source_message_id: null, source_call_id: null, client_task_id: "client-1", title: "Routine research",
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

test("completed work automatically clears from the review panel", () => {
  assert.equal(agentTaskBelongsInWorkPanel(task({ status: "completed", artifacts: [artifact({ kind: "email_draft" })] })), false);
  assert.deepEqual(visibleAgentWorkTasks([task({ status: "completed" })]), []);
});

test("the review panel keeps email work and approvals, not routine progress", () => {
  assert.equal(agentTaskBelongsInWorkPanel(task()), false);
  assert.equal(agentTaskBelongsInWorkPanel(task({ title: "Draft client email" })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ status: "awaiting_approval" })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ artifacts: [artifact({ kind: "email_draft" })] })), true);
});

test("structured tables and lists remain visible for glanceable review", () => {
  assert.equal(agentTaskBelongsInWorkPanel(task({ artifacts: [artifact({ content: { rows: [{ item: "Window" }] } })] })), true);
  assert.equal(agentTaskBelongsInWorkPanel(task({ artifacts: [artifact({ content: { text: "- First\n- Second" } })] })), true);
});
