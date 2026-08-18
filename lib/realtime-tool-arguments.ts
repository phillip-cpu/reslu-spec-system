import type { AgentSlug } from "@/types/conversations";

export interface RealtimeConsultArguments {
  query: string;
}

export interface RealtimeSpecialistArguments extends RealtimeConsultArguments {
  targetAgent: AgentSlug;
}

export interface RealtimeTaskArguments {
  title: string;
  objective: string;
  modelTier: "fast" | "standard" | "strong";
}

function cleanText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
}

function parseObject(argumentsJson: string) {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseRealtimeConsultArguments(argumentsJson: string): RealtimeConsultArguments | null {
  const parsed = parseObject(argumentsJson);
  const query = cleanText(parsed?.query, 20_000);
  return query ? { query } : null;
}

export function parseRealtimeSpecialistArguments(
  argumentsJson: string,
  ownerAgent: AgentSlug,
): RealtimeSpecialistArguments | null {
  const parsed = parseObject(argumentsJson);
  const query = cleanText(parsed?.query, 20_000);
  const targetAgent = parsed?.target_agent_slug === "aria"
    || parsed?.target_agent_slug === "marco"
    || parsed?.target_agent_slug === "stuart"
    ? parsed.target_agent_slug
    : null;
  return query && targetAgent && targetAgent !== ownerAgent ? { query, targetAgent } : null;
}

export function parseRealtimeTaskArguments(argumentsJson: string): RealtimeTaskArguments | null {
  const parsed = parseObject(argumentsJson);
  const title = cleanText(parsed?.title, 200);
  const objective = cleanText(parsed?.objective, 20_000);
  if (!title || !objective) return null;
  const modelTier = parsed?.model_tier === "fast" || parsed?.model_tier === "strong"
    ? parsed.model_tier
    : "standard";
  return { title, objective, modelTier };
}
