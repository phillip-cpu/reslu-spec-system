import type { AgentSlug } from "@/types/conversations";

export interface RealtimeSpecialistConsultRequest {
  query: string;
  ownerAgentSlug: AgentSlug;
  targetAgentSlug: AgentSlug;
  callId: string;
  toolCallId: string;
  responseId: string | null;
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,160}$/.test(trimmed) ? trimmed : null;
}

const RESLU_AGENT_SLUGS: AgentSlug[] = ["aria", "marco", "stuart"];

export function resluSpecialistAgents(owner: AgentSlug): AgentSlug[] {
  return RESLU_AGENT_SLUGS.filter((slug) => slug !== owner);
}

export function parseRealtimeSpecialistConsultRequest(value: unknown): RealtimeSpecialistConsultRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const ownerAgentSlug = RESLU_AGENT_SLUGS.includes(body.owner_agent_slug as AgentSlug)
    ? body.owner_agent_slug as AgentSlug
    : null;
  const targetAgentSlug = RESLU_AGENT_SLUGS.includes(body.target_agent_slug as AgentSlug)
    ? body.target_agent_slug as AgentSlug
    : null;
  const callId = safeProviderId(body.call_id);
  const toolCallId = safeProviderId(body.tool_call_id);
  const responseId = body.response_id == null ? null : safeProviderId(body.response_id);
  if (!query || query.length > 20_000 || !ownerAgentSlug || !targetAgentSlug
    || targetAgentSlug === ownerAgentSlug || !callId || !toolCallId) return null;
  if (body.response_id != null && !responseId) return null;
  return { query, ownerAgentSlug, targetAgentSlug, callId, toolCallId, responseId };
}
