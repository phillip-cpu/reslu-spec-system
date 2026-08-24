import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  classifyResluConversationPrompt,
  evaluateResluConversationTool,
  isResluConversationSession,
} from "./policy.mjs";
import { createMarcoGmailSendTool, createReadonlyGoogleTools } from "./google-readonly.mjs";
import { clearBridgeEnvelope, loadBridgeEnvelope, persistBridgeEnvelope } from "./envelope.mjs";

export default definePluginEntry({
  id: "reslu-conversation-guard",
  name: "RESLU Conversation Guard",
  description: "Enforces the trusted tool boundary for untrusted RESLU conversation content.",
  register(api) {
    const runs = new Map();

    const persistValidatedRun = (event, context) => {
      if (!isResluConversationSession(context.sessionKey)) return null;
      const mode = classifyResluConversationPrompt(event.prompt);
      if (!mode || !context.runId || !context.workspaceDir) return null;
      const state = { mode, workspaceDir: context.workspaceDir };
      runs.set(context.runId, state);
      if (!persistBridgeEnvelope({ sessionKey: context.sessionKey, runId: context.runId, ...state })) {
        runs.delete(context.runId);
        return null;
      }
      return state;
    };

    api.registerTool(
      (context) => createReadonlyGoogleTools(context),
      {
        names: [
          "reslu_calendar_events_list",
          "reslu_gmail_messages_search",
          "reslu_gmail_message_read",
          "reslu_attachment_pdf_text_read",
        ],
      },
    );

    api.registerTool(
      (context) => createMarcoGmailSendTool(context),
      { names: ["reslu_gmail_messages_send"] },
    );

    // The Codex app-server harness does not currently emit before_agent_run,
    // but it does pass through model resolution before exposing MCP tools.
    // Validate and persist the same fail-closed envelope at that earlier,
    // runtime-neutral boundary. Native harnesses retain the blocking gate below.
    api.on("before_model_resolve", (event, context) => {
      persistValidatedRun(event, context);
    }, { priority: 1000 });

    api.on("before_agent_run", (event, context) => {
      if (!isResluConversationSession(context.sessionKey)) return { outcome: "pass" };
      if (!persistValidatedRun(event, context)) {
        return {
          outcome: "block",
          reason: "RESLU conversation envelope was missing or invalid",
          message: "RESLU could not verify this conversation request. Please retry.",
          category: "reslu_conversation_boundary",
        };
      }
      return { outcome: "pass" };
    }, { priority: 1000 });

    api.registerTrustedToolPolicy({
      id: "reslu-session-boundary",
      description: "Blocks host, mutation and cross-session tools for untrusted RESLU conversation turns.",
      evaluate(event, context) {
        const runId = event.runId ?? context.runId;
        const state = (runId ? runs.get(runId) : null) ?? loadBridgeEnvelope(context.sessionKey);
        return evaluateResluConversationTool(event, context, state);
      },
    });

    api.on("agent_end", (event, context) => {
      const runId = event.runId ?? context.runId;
      if (runId) runs.delete(runId);
      if (isResluConversationSession(context.sessionKey)) clearBridgeEnvelope(context.sessionKey, runId);
    });
  },
});
