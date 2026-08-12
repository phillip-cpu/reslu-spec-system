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
  if (["completed", "cancelled"].includes(task.status)) return false;
  if (task.status === "awaiting_approval") return true;
  if (task.artifacts.some(agentTaskArtifactNeedsReview)) return true;
  return [task.title, task.objective].some((value) => EMAIL_WORD.test(value));
}

export function visibleAgentWorkTasks(tasks: AgentTask[], limit = 6) {
  return tasks.filter(agentTaskBelongsInWorkPanel).slice(0, limit);
}
