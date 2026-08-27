import type { AgentTask, AgentTaskArtifact } from "../types/conversations.ts";
import { normalizeAgentTaskArtifactContent } from "./agent-task-artifact.ts";

const EMAIL_WORD = /\b(e-?mail|inbox|recipient|subject line)\b/i;
const MARKDOWN_TABLE = /\n\s*\|?\s*:?-{3,}:?\s*\|/;
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+\S+/gm;

function containsStructuredValue(value: unknown, depth = 0): boolean {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") {
    return MARKDOWN_TABLE.test(value) || (value.match(LIST_LINE)?.length ?? 0) >= 2;
  }
  if (typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (["rows", "columns", "items", "table", "list"].some((key) => Array.isArray(object[key]) && object[key].length > 0)) {
    return true;
  }
  return Object.values(object).some((entry) => containsStructuredValue(entry, depth + 1));
}

export function agentTaskArtifactNeedsReview(artifact: AgentTaskArtifact) {
  if (artifact.kind === "email_draft") return true;
  const content = normalizeAgentTaskArtifactContent(artifact.content);
  if (typeof content.to === "string" || typeof content.subject === "string") return true;
  return containsStructuredValue(content);
}

export function agentTaskBelongsInWorkPanel(task: AgentTask) {
  // The work centre is the durable record of delegated work. Hiding routine or
  // completed tasks makes the chat look clean, but prevents people from
  // answering the more important question: "what did the agent actually do?"
  // Per-person dismissals are already applied by the API, so every returned
  // task belongs here until that person explicitly clears it.
  if (["queued", "running", "completed", "cancelled", "failed"].includes(task.status)) return true;
  if (task.status === "awaiting_approval") {
    const hasDraftArtifact = task.artifacts.some((artifact) => artifact.status === "draft");
    const hasDecidedArtifact = task.artifacts.some((artifact) =>
      artifact.status === "approved"
      || artifact.status === "rejected"
      || artifact.status === "published"
    );

    // The approval RPC normally advances the task immediately. If an older or
    // partially completed task still says awaiting_approval after every
    // artifact has already been decided, do not leave a contradictory
    // "Needs approval / Approved" card pinned above the conversation.
    if (hasDecidedArtifact && !hasDraftArtifact) return true;
    return true;
  }
  return task.artifacts.some(agentTaskArtifactNeedsReview)
    || [task.title, task.objective].some((value) => EMAIL_WORD.test(value));
}

const TASK_PRIORITY: Record<AgentTask["status"], number> = {
  awaiting_approval: 0,
  failed: 1,
  running: 2,
  queued: 3,
  completed: 4,
  cancelled: 5,
};

export function visibleAgentWorkTasks(tasks: AgentTask[], limit = 40) {
  return tasks
    .filter(agentTaskBelongsInWorkPanel)
    .sort((left, right) => {
      const priority = TASK_PRIORITY[left.status] - TASK_PRIORITY[right.status];
      if (priority !== 0) return priority;
      return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
    })
    .slice(0, limit);
}
