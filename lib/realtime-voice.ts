import { createHash } from "node:crypto";
import type { AgentSlug } from "@/types/conversations";

export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
] as const;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number];

export interface RealtimeConfig {
  enabled: boolean;
  model: string;
  voice: RealtimeVoice;
  apiKey: string | null;
}

export interface RealtimeProviderResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
}

type Environment = Record<string, string | undefined>;

export function realtimeConfig(environment: Environment, agentSlug: AgentSlug): RealtimeConfig {
  const configuredVoice = environment[`RESLU_REALTIME_${agentSlug.toUpperCase()}_VOICE`]
    ?? environment.RESLU_REALTIME_VOICE_NAME
    ?? (agentSlug === "aria" ? "marin" : "cedar");
  const voice = REALTIME_VOICES.includes(configuredVoice as RealtimeVoice)
    ? configuredVoice as RealtimeVoice
    : agentSlug === "aria" ? "marin" : "cedar";
  return {
    enabled: environment.RESLU_REALTIME_VOICE_ENABLED === "true",
    model: environment.RESLU_REALTIME_VOICE_MODEL?.trim() || "gpt-realtime-2.1",
    voice,
    apiKey: environment.OPENAI_API_KEY?.trim() || null,
  };
}

export function realtimeSafetyIdentifier(userId: string): string {
  return createHash("sha256").update(`reslu-realtime:${userId}`).digest("hex");
}

export function buildRealtimeSession(agent: { slug: AgentSlug; display_name: string }, config: RealtimeConfig) {
  return {
    type: "realtime",
    model: config.model,
    output_modalities: ["audio"],
    instructions: [
      `You are the realtime voice transport for ${agent.display_name} inside RESLU staff chat.`,
      "You handle audio turn-taking only. You do not possess RESLU memory, calendar, project, finance, email or business tools.",
      "For every completed user request or question, call consult_reslu_agent with a faithful concise transcript of what the user asked.",
      "Never answer a substantive question yourself and never claim a business action happened unless the tool output says so.",
      "After tool output arrives, speak its answer faithfully and naturally. Do not add facts, actions or recommendations.",
      "If interrupted, stop immediately. An interruption does not undo a tool or business side effect that may already have completed.",
    ].join(" "),
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: config.voice },
    },
    tools: [{
      type: "function",
      name: "consult_reslu_agent",
      description: `Send the user's substantive turn to the existing ${agent.display_name} OpenClaw session, which owns all RESLU memory, tools and business actions.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "A faithful transcript of the user's current request, including names, dates and constraints they stated.",
          },
        },
        required: ["query"],
      },
    }],
    tool_choice: "required",
  };
}

export async function createRealtimeWebRtcCall(options: {
  sdp: string;
  session: ReturnType<typeof buildRealtimeSession>;
  apiKey: string;
  safetyIdentifier: string;
  fetchImpl?: typeof fetch;
}): Promise<RealtimeProviderResult> {
  const form = new FormData();
  form.set("sdp", options.sdp);
  form.set("session", JSON.stringify(options.session));
  const response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "OpenAI-Safety-Identifier": options.safetyIdentifier,
    },
    body: form,
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type") || "text/plain",
  };
}

export interface RealtimeTurnState {
  responseId: string | null;
  toolCallId: string | null;
  cancelledResponseIds: Set<string>;
  cancelledToolCallIds: Set<string>;
}

export function cancelRealtimeTurn(state: RealtimeTurnState): RealtimeTurnState {
  const cancelledResponseIds = new Set(state.cancelledResponseIds);
  const cancelledToolCallIds = new Set(state.cancelledToolCallIds);
  if (state.responseId) cancelledResponseIds.add(state.responseId);
  if (state.toolCallId) cancelledToolCallIds.add(state.toolCallId);
  return { responseId: null, toolCallId: null, cancelledResponseIds, cancelledToolCallIds };
}

export function shouldAcceptRealtimeOutput(state: RealtimeTurnState, responseId: string | null, toolCallId?: string | null): boolean {
  return (!responseId || !state.cancelledResponseIds.has(responseId))
    && (!toolCallId || !state.cancelledToolCallIds.has(toolCallId));
}
