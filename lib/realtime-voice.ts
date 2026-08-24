import { createHash } from "node:crypto";
import { otherResluAgent } from "./realtime-specialist-consult.ts";
import type { AgentSlug } from "@/types/conversations";

export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
] as const;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number];

const DEFAULT_REALTIME_VOICES: Record<AgentSlug, RealtimeVoice> = {
  aria: "marin",
  marco: "cedar",
  stuart: "echo",
};

const REALTIME_PERSONALITIES: Record<AgentSlug, string> = {
  aria: "Speak as Aria: immaculate, controlled and exceptionally professional. Be slick, precise and quietly decisive, with excellent taste and no visible personal side. Never become chatty, confessional, gushy or playful.",
  marco: "Speak as Marco, RESLU's marketing intelligence: outgoing, energetic, socially confident and lightly witty. Bring a little fun and charm without forcing jokes, becoming flippant or losing commercial focus.",
  stuart: "Speak as Stuart: deliberately dry, conservative, terse and financially disciplined, in an understated Australian professional style. Lead with the number, evidence, risk and recommendation. No charm offensive, theatrics or unnecessary warmth.",
};

export interface RealtimeConfig {
  enabled: boolean;
  model: string;
  voice: RealtimeVoice;
  transcriptionModel: string;
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
  const defaultVoice = DEFAULT_REALTIME_VOICES[agentSlug];
  const configuredVoice = environment[`RESLU_REALTIME_${agentSlug.toUpperCase()}_VOICE`]
    ?? environment.RESLU_REALTIME_VOICE_NAME
    ?? defaultVoice;
  const voice = REALTIME_VOICES.includes(configuredVoice as RealtimeVoice)
    ? configuredVoice as RealtimeVoice
    : defaultVoice;
  return {
    enabled: environment.RESLU_REALTIME_VOICE_ENABLED === "true",
    model: environment.RESLU_REALTIME_VOICE_MODEL?.trim() || "gpt-realtime-2.1-mini",
    voice,
    transcriptionModel: environment.RESLU_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-live-transcribe",
    apiKey: environment.OPENAI_API_KEY?.trim() || null,
  };
}

export function realtimeSafetyIdentifier(userId: string): string {
  return createHash("sha256").update(`reslu-realtime:${userId}`).digest("hex");
}

export function buildRealtimeSession(agent: { slug: AgentSlug; display_name: string }, config: RealtimeConfig) {
  const specialistSlug = otherResluAgent(agent.slug);
  const specialistName = specialistSlug === "aria" ? "Aria" : "Marco";
  return {
    type: "realtime",
    model: config.model,
    max_output_tokens: 1024,
    output_modalities: ["audio"],
    reasoning: { effort: "low" },
    instructions: [
      `You are the realtime voice transport for ${agent.display_name} inside RESLU staff chat.`,
      REALTIME_PERSONALITIES[agent.slug],
      "Remain silent while tools or the existing RESLU agent are working. Never narrate waiting, searching, checking or routine tool use. Speak only when you have a useful result, need one necessary clarification, or can truthfully confirm a completed action.",
      "You handle audio turn-taking only. You do not possess RESLU memory, calendar, project, finance, email or business tools.",
      "For every completed user turn, choose exactly one tool and include a faithful concise transcript of what the user asked.",
      "When the user asks you to create, prepare, research, review, compose, organize, update, or otherwise complete work that can continue independently, call start_reslu_task instead of consult_reslu_agent.",
      `When the user explicitly asks for ${specialistName}'s input, or the question clearly needs ${specialistName}'s distinct specialist perspective, call consult_reslu_specialist. The visible agent remains the owner of the conversation.`,
      "Use model_tier strong only for genuinely complex, high-value or multi-step work; use standard for normal tasks and fast for simple mechanical work.",
      "Never answer a substantive question yourself and never claim a business action happened unless the tool output says so.",
      "After tool output arrives, speak its answer faithfully and naturally. Do not add facts, actions or recommendations.",
      "If interrupted, stop immediately. An interruption does not undo a tool or business side effect that may already have completed.",
    ].join(" "),
    audio: {
      input: {
        transcription: {
          model: config.transcriptionModel,
          delay: "low",
          languages: ["en"],
          prompt: "RESLU residential design and construction call. Common names include Aria, Marco, Stuart, Phillip and Tennille. Stuart handles finance, forecasting and cost intelligence.",
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: config.voice },
    },
    tools: [
      {
        type: "function",
        name: "consult_reslu_agent",
        description: `Get a conversational answer from the existing ${agent.display_name} OpenClaw session. Use for questions, status checks, quick lookups and discussion that should return during this call.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: "A faithful transcript of the user's current question, including names, dates and constraints they stated.",
            },
          },
          required: ["query"],
        },
      },
      {
        type: "function",
        name: "consult_reslu_specialist",
        description: `Ask ${specialistName} for a bounded second opinion while ${agent.display_name} remains the visible owner. Use only for explicit cross-agent input or a clearly specialist question. This is advisory and must not perform consequential actions or start durable work.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: `A faithful standalone question for ${specialistName}, including the user's names, dates and constraints.`,
            },
          },
          required: ["query"],
        },
      },
      {
        type: "function",
        name: "start_reslu_task",
        description: `Start durable work owned by ${agent.display_name}. The work continues if speech is interrupted, the call ends, or the device locks. Use for creating, preparing, composing, researching, reviewing, organizing or completing a deliverable.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
              description: "A short human-readable task title, no more than about eight words.",
            },
            objective: {
              type: "string",
              description: "A faithful standalone task objective including every relevant name, date, constraint and requested deliverable.",
            },
            model_tier: {
              type: "string",
              enum: ["fast", "standard", "strong"],
              description: "fast for simple mechanical work, standard for normal work, strong for difficult multi-step or high-value work.",
            },
          },
          required: ["title", "objective", "model_tier"],
        },
      },
      ...(agent.slug === "aria" ? [{
        type: "function",
        name: "start_meeting_mode",
        description: "Switch this Aria call into silent Meeting Mode when the user asks to take, record or capture meeting minutes. Do not use for ordinary notes or call summaries.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [] as string[],
        },
      }] : []),
    ],
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
