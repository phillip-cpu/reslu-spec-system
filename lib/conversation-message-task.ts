import type { ConversationMessage, ConversationParticipant } from "../types/conversations";
import type { StartAgentTaskRequest } from "./agent-tasks";

type TaskSourceMessage = Pick<ConversationMessage,
  "id" | "conversation_id" | "author_profile_id" | "author_agent_id" | "deleted_at" | "kind" | "body" | "metadata"
> & { attachments: unknown[] };

/** A task starts only from the current human's direct text, never forwarded evidence. */
export function conversationMessageTask(
  message: TaskSourceMessage,
  conversationId: string,
  currentUserId: string,
  participants: ConversationParticipant[],
) {
  const agents = participants.filter(participant => participant.type === "agent");
  const agent = agents.length === 1 ? agents[0] : null;
  const objective = message.body.trim();
  if (!agent?.agent_slug || !participants.some(participant => participant.type === "human" && participant.id === currentUserId)
    || message.conversation_id !== conversationId || message.author_profile_id !== currentUserId
    || message.author_agent_id || message.deleted_at || message.kind !== "text"
    || message.attachments.length || !objective || objective.length > 20_000
    || message.metadata.source === "forward" || message.metadata.source === "agent_consultation"
    || message.metadata.source === "agent_task" || message.metadata.agent_task_id || message.metadata.task_id) return null;

  return {
    client_task_id: `message-${message.id}-${agent.agent_slug}`,
    agent_slug: agent.agent_slug,
    title: objective.split("\n", 1)[0].slice(0, 200),
    objective,
    requested_via: "text" as const,
    model_tier: "standard" as const,
    source_message_id: message.id,
    source_message_task: true as const,
  };
}

/** The server compares the submitted intent with the authenticated canonical message. */
export function matchesConversationMessageTask(
  request: StartAgentTaskRequest,
  message: TaskSourceMessage,
  conversationId: string,
  currentUserId: string,
  participants: ConversationParticipant[],
) {
  const expected = conversationMessageTask(message, conversationId, currentUserId, participants);
  return Boolean(expected && request.sourceMessageTask && !request.sourceCallId
    && request.clientTaskId === expected.client_task_id && request.agentSlug === expected.agent_slug
    && request.sourceMessageId === expected.source_message_id && request.title === expected.title
    && request.objective === expected.objective && request.requestedVia === expected.requested_via
    && request.modelTier === expected.model_tier);
}
