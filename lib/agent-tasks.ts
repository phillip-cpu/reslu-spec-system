import type { AgentSlug, AgentTaskModelTier } from "@/types/conversations";

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,160}$/;

export interface StartAgentTaskRequest {
  clientTaskId: string;
  agentSlug: AgentSlug;
  title: string;
  objective: string;
  modelTier: AgentTaskModelTier;
  requestedVia: "text" | "voice";
  sourceCallId: string | null;
  sourceMessageId: string | null;
}

export interface RealtimeAgentTaskRequest extends StartAgentTaskRequest {
  realtimeResponseId: string | null;
}

function cleanText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
}

export function parseStartAgentTaskRequest(value: unknown): StartAgentTaskRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const clientTaskId = cleanText(body.client_task_id, 160);
  const title = cleanText(body.title, 200);
  const objective = cleanText(body.objective, 20_000);
  const agentSlug = body.agent_slug === "aria" || body.agent_slug === "marco" || body.agent_slug === "stuart"
    ? body.agent_slug
    : null;
  const modelTier = body.model_tier === "fast" || body.model_tier === "strong" ? body.model_tier : "standard";
  const requestedVia = body.requested_via === "voice" ? "voice" : "text";
  const sourceCallId = body.source_call_id == null ? null : cleanText(body.source_call_id, 160);
  const sourceMessageId = body.source_message_id == null ? null : cleanText(body.source_message_id, 160);
  if (!clientTaskId || !PROVIDER_ID.test(clientTaskId) || !title || !objective || !agentSlug) return null;
  if (body.source_call_id != null && !sourceCallId) return null;
  if (body.source_message_id != null && !sourceMessageId) return null;
  return { clientTaskId, agentSlug, title, objective, modelTier, requestedVia, sourceCallId, sourceMessageId };
}

export function parseRealtimeAgentTaskRequest(value: unknown): RealtimeAgentTaskRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const parsed = parseStartAgentTaskRequest({
    ...body,
    client_task_id: body.tool_call_id,
    requested_via: "voice",
    source_call_id: body.call_id,
  });
  const realtimeResponseId = body.response_id == null ? null : cleanText(body.response_id, 160);
  if (!parsed || !parsed.sourceCallId || (body.response_id != null && !realtimeResponseId)) return null;
  return { ...parsed, realtimeResponseId };
}

export function realtimeTaskAcknowledgement(title: string) {
  return `I’ve started “${title}” in the background. You can keep talking or end the call; I’ll post the result here.`;
}

export function taskIntentMatches(
  existing: { title: string; objective: string; owner_agent_id: string; model_tier: string },
  requested: StartAgentTaskRequest,
  agentId: string
) {
  return existing.title === requested.title
    && existing.objective === requested.objective
    && existing.owner_agent_id === agentId
    && existing.model_tier === requested.modelTier;
}
