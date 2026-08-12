import type { AgentSlug } from "@/types/conversations";

export interface RealtimeSpecialistConsultRequest {
  query: string;
  ownerAgentSlug: AgentSlug;
  callId: string;
  toolCallId: string;
  responseId: string | null;
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,160}$/.test(trimmed) ? trimmed : null;
}

export function otherResluAgent(owner: AgentSlug): AgentSlug {
  return owner === "aria" ? "marco" : "aria";
}

export function parseRealtimeSpecialistConsultRequest(value: unknown): RealtimeSpecialistConsultRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const ownerAgentSlug = body.owner_agent_slug === "aria" || body.owner_agent_slug === "marco"
    ? body.owner_agent_slug
    : null;
  const callId = safeProviderId(body.call_id);
  const toolCallId = safeProviderId(body.tool_call_id);
  const responseId = body.response_id == null ? null : safeProviderId(body.response_id);
  if (!query || query.length > 20_000 || !ownerAgentSlug || !callId || !toolCallId) return null;
  if (body.response_id != null && !responseId) return null;
  return { query, ownerAgentSlug, callId, toolCallId, responseId };
}
