import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedCachedConversationMessages,
  conversationMessageCacheKey,
  MAX_CACHED_CONVERSATION_MESSAGES,
} from "./conversation-offline-cache.ts";
import type { ConversationMessage } from "@/types/conversations";

function message(index: number): ConversationMessage {
  return {
    id: `message-${index}`,
    client_message_id: null,
    conversation_id: "conversation",
    author_profile_id: "profile",
    author_agent_id: null,
    kind: "text",
    body: `Message ${index}`,
    metadata: {},
    reply_to_id: null,
    created_at: new Date(index * 1000).toISOString(),
    edited_at: null,
    deleted_at: null,
    reactions: [],
    pinned_at: null,
    pinned_by: null,
    attachments: [],
    author: {
      id: "profile",
      type: "human",
      display_name: "Phillip",
      avatar_url: null,
      is_self: true,
    },
  };
}

test("offline message snapshots retain only the newest bounded canonical window", () => {
  const source = Array.from({ length: 135 }, (_, index) => message(index));
  const cached = boundedCachedConversationMessages(source);
  assert.equal(cached.length, MAX_CACHED_CONVERSATION_MESSAGES);
  assert.equal(cached[0].id, "message-35");
  assert.equal(cached.at(-1)?.id, "message-134");
  assert.equal(source.length, 135, "bounding must not mutate the live timeline");
});

test("offline message cache keys cannot collide across profiles or conversations", () => {
  assert.notEqual(conversationMessageCacheKey("phillip", "aria"), conversationMessageCacheKey("other", "aria"));
  assert.notEqual(conversationMessageCacheKey("phillip", "aria"), conversationMessageCacheKey("phillip", "marco"));
});
