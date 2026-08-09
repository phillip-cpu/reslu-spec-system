import type { AgentSlug } from "@/types/conversations";

export interface RealtimeConsultRequest {
  query: string;
  agentSlug: AgentSlug;
  callId: string;
  toolCallId: string;
  responseId: string | null;
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,160}$/.test(trimmed) ? trimmed : null;
}

export function parseRealtimeConsultRequest(value: unknown): RealtimeConsultRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const agentSlug = body.agent_slug === "aria" || body.agent_slug === "marco" ? body.agent_slug : null;
  const callId = safeProviderId(body.call_id);
  const toolCallId = safeProviderId(body.tool_call_id);
  const responseId = body.response_id == null ? null : safeProviderId(body.response_id);
  if (!query || query.length > 20_000 || !agentSlug || !callId || !toolCallId) return null;
  if (body.response_id != null && !responseId) return null;
  return { query, agentSlug, callId, toolCallId, responseId };
}

export function consultStatus(status: string, hasReply: boolean) {
  if (status === "cancelled") return "cancelled" as const;
  if (status === "failed") return "failed" as const;
  if (status === "done" && hasReply) return "done" as const;
  return "pending" as const;
}
