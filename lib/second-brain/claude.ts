/**
 * RESLU Second Brain, Step 9 (docs/RESLU-second-brain-build-brief.md).
 * Anthropic Messages API wrapper — plain fetch(), not the
 * `@anthropic-ai/sdk` package. This repo has zero existing Claude API
 * usage anywhere (checked package.json and grepped lib/+app/api/ —
 * nothing), same call already made for OpenAI embeddings in Step 5's
 * lib/second-brain/embeddings.ts: a single-endpoint need doesn't
 * justify a new SDK dependency in a codebase that otherwise hand-rolls
 * every external HTTP call (lib/scraper/ being the other example).
 *
 * Every caller forces a specific tool via tool_choice — this app never
 * wants free-text Claude output, only structured tool-call results
 * (triage labels, extraction facts), so the "did the model even call
 * the tool" branch doesn't need handling here: forcing tool_choice
 * guarantees it.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

export type ClaudeTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type CallClaudeParams = {
  model: string;
  system: string;
  messages: ClaudeMessage[];
  tool: ClaudeTool;
  maxTokens?: number;
  cacheSystemPrompt?: boolean;
};

export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type CallClaudeResult = {
  toolInput: unknown;
  usage: ClaudeUsage;
};

/**
 * Calls Claude with a single forced tool and returns that tool call's
 * parsed input. Throws on any non-2xx response or if the model
 * somehow didn't call the forced tool (shouldn't happen with
 * tool_choice, but fail loudly rather than return undefined silently
 * — matches Step 5's embeddings.ts "fail loudly" convention for this
 * subsystem, unlike lib/scraper's "never throw").
 */
export async function callClaude({
  model,
  system,
  messages,
  tool,
  maxTokens = 4096,
  cacheSystemPrompt = false,
}: CallClaudeParams): Promise<CallClaudeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot call Claude.");
  }

  const systemBlock = cacheSystemPrompt
    ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
    : system;

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemBlock,
      messages,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    content: { type: string; id?: string; name?: string; input?: unknown }[];
    usage: ClaudeUsage;
  };

  const toolUse = json.content.find((block) => block.type === "tool_use" && block.name === tool.name);
  if (!toolUse) {
    throw new Error(`Claude did not call the forced tool "${tool.name}" — unexpected response shape.`);
  }

  return { toolInput: toolUse.input, usage: json.usage };
}
