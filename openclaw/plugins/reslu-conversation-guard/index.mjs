import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  classifyResluConversationPrompt,
  evaluateResluConversationTool,
  isResluConversationSession,
} from "./policy.mjs";
import { createReadonlyGoogleTools } from "./google-readonly.mjs";
import { clearBridgeEnvelope, loadBridgeEnvelope, persistBridgeEnvelope } from "./envelope.mjs";

export default definePluginEntry({
  id: "reslu-conversation-guard",
  name: "RESLU Conversation Guard",
  description: "Enforces the trusted tool boundary for untrusted RESLU conversation content.",
  register(api) {
    const runs = new Map();

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

    api.on("before_agent_run", (event, context) => {
      if (!isResluConversationSession(context.sessionKey)) return { outcome: "pass" };
      const mode = classifyResluConversationPrompt(event.prompt);
      if (!mode || !context.runId || !context.workspaceDir) {
        return {
          outcome: "block",
          reason: "RESLU conversation envelope was missing or invalid",
          message: "RESLU could not verify this conversation request. Please retry.",
          category: "reslu_conversation_boundary",
        };
      }
      const state = { mode, workspaceDir: context.workspaceDir };
      runs.set(context.runId, state);
      if (!persistBridgeEnvelope({ sessionKey: context.sessionKey, runId: context.runId, ...state })) {
        runs.delete(context.runId);
        return {
          outcome: "block",
          reason: "RESLU conversation envelope could not be persisted",
          message: "RESLU could not secure this conversation request. Please retry.",
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
