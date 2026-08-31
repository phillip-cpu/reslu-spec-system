import type {
  AgentTask,
  AgentTaskArtifact,
  AgentTaskEvent,
  ConversationMessage,
} from "@/types/conversations";

export type AgentAssignmentView = "active" | "waiting" | "done";
export type AgentAssignmentTab = "chat" | "activity" | "evidence" | "changes" | "approvals";

export function agentAssignmentView(task: AgentTask): AgentAssignmentView {
  if (["completed", "cancelled"].includes(task.status)) return "done";
  if (task.status === "awaiting_approval" || task.status === "failed") return "waiting";
  return "active";
}

export function agentAssignmentStatusLabel(task: AgentTask) {
  if (task.status === "awaiting_approval") return "Waiting on you";
  if (task.status === "running") return task.progress_label?.trim() || "Working";
  if (task.status === "queued") return "Waiting to start";
  if (task.status === "completed") return "Completed";
  if (task.status === "failed") return "Needs recovery";
  return "Stopped";
}

export function filterAgentAssignments(tasks: AgentTask[], view: AgentAssignmentView) {
  return tasks.filter((task) => agentAssignmentView(task) === view);
}

export function messagesForAgentAssignment(messages: ConversationMessage[], taskId: string) {
  return messages.filter((message) => message.metadata?.agent_task_id === taskId);
}

export function evidenceArtifacts(task: AgentTask) {
  return task.artifacts.filter((artifact) => ["text", "report", "file"].includes(artifact.kind));
}

export function changeArtifacts(task: AgentTask) {
  return task.artifacts.filter((artifact) => ["record_change", "email_draft"].includes(artifact.kind));
}

export function approvalArtifacts(task: AgentTask) {
  return task.artifacts.filter((artifact) => artifact.status === "draft");
}

export function artifactSummary(artifact: AgentTaskArtifact) {
  const content = artifact.content ?? {};
  for (const key of ["summary", "description", "text", "body", "message", "filename", "url"]) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return artifact.kind.replaceAll("_", " ");
}

function safeEventMetadataString(event: AgentTaskEvent | undefined, key: string) {
  const value = event?.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface AgentComputerState {
  screenshotUrl: string | null;
  controlUrl: string | null;
  application: string | null;
  location: string | null;
  tool: string | null;
}

export function latestAgentComputerState(task: AgentTask): AgentComputerState {
  const newestFirst = [...task.events].reverse();
  const screenshotEvent = newestFirst.find((event) => safeEventMetadataString(event, "screenshot_url"));
  const controlEvent = newestFirst.find((event) => safeEventMetadataString(event, "control_url"));
  const applicationEvent = newestFirst.find((event) => safeEventMetadataString(event, "application"));
  const locationEvent = newestFirst.find((event) => safeEventMetadataString(event, "url") || safeEventMetadataString(event, "location"));
  const toolEvent = newestFirst.find((event) => safeEventMetadataString(event, "tool_name") || safeEventMetadataString(event, "tool"));
  return {
    screenshotUrl: safeEventMetadataString(screenshotEvent, "screenshot_url"),
    controlUrl: safeEventMetadataString(controlEvent, "control_url"),
    application: safeEventMetadataString(applicationEvent, "application"),
    location: safeEventMetadataString(locationEvent, "url") ?? safeEventMetadataString(locationEvent, "location"),
    tool: safeEventMetadataString(toolEvent, "tool_name") ?? safeEventMetadataString(toolEvent, "tool"),
  };
}

export function assignmentLastUpdatedAt(task: AgentTask) {
  return task.progress_updated_at ?? task.updated_at ?? task.created_at;
}
