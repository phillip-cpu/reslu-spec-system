import type {
  ConversationMessage,
  ConversationParticipant,
  ConversationSummary,
} from "@/types/conversations";

export function conversationDisplayTitle(
  title: string | null,
  participants: ConversationParticipant[],
  currentUserId: string
): string {
  const explicit = title?.trim();
  if (explicit) return explicit;
  const others = participants.filter((participant) => participant.id !== currentUserId || participant.type !== "human");
  if (others.length === 0) return "Just you";
  return others.map((participant) => participant.display_name).join(", ");
}
export function messageAuthor(
  message: Pick<ConversationMessage, "author_profile_id" | "author_agent_id">,
  participants: ConversationParticipant[]
): ConversationParticipant {
  const match = participants.find((participant) =>
    participant.type === "human"
      ? participant.id === message.author_profile_id
      : participant.id === message.author_agent_id
  );
  return match ?? {
    id: "unknown",
    type: "human",
    display_name: "Former participant",
    avatar_url: null,
  };
}

export function sortConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort((left, right) => {
    const leftDate = left.last_message?.created_at ?? left.updated_at;
    const rightDate = right.last_message?.created_at ?? right.updated_at;
    return rightDate.localeCompare(leftDate);
  });
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}
