import type { ConversationMessageReaction } from "@/types/conversations";

export const CONVERSATION_MESSAGE_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
export type ConversationMessageReactionValue = typeof CONVERSATION_MESSAGE_REACTIONS[number];

export type ConversationMessageReactionRow = {
  reaction: string;
  profile_id: string;
};

export function isConversationMessageReaction(value: unknown): value is ConversationMessageReactionValue {
  return typeof value === "string"
    && CONVERSATION_MESSAGE_REACTIONS.includes(value as ConversationMessageReactionValue);
}

export function summarizeConversationMessageReactions(
  rows: ConversationMessageReactionRow[],
  selfProfileId: string | null
): ConversationMessageReaction[] {
  return CONVERSATION_MESSAGE_REACTIONS.flatMap((reaction) => {
    const matches = rows.filter((row) => row.reaction === reaction);
    if (matches.length === 0) return [];
    return [{
      reaction,
      count: matches.length,
      self_reacted: Boolean(selfProfileId && matches.some((row) => row.profile_id === selfProfileId)),
    }];
  });
}
