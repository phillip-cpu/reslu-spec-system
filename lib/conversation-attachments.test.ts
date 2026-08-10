import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanConversationAttachmentFilename,
  conversationAttachmentKind,
  conversationAttachmentStoragePath,
  isConversationAttachmentMime,
  isConversationAttachmentSize,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
} from "./conversation-attachments.ts";

test("conversation attachments accept only the first MVP photo and PDF formats", () => {
  assert.equal(isConversationAttachmentMime("image/jpeg"), true);
  assert.equal(isConversationAttachmentMime("image/png"), true);
  assert.equal(isConversationAttachmentMime("image/webp"), true);
  assert.equal(isConversationAttachmentMime("application/pdf"), true);
  assert.equal(isConversationAttachmentMime("image/svg+xml"), false);
  assert.equal(isConversationAttachmentMime("application/x-sh"), false);
});

test("conversation attachment paths cannot preserve client path traversal", () => {
  assert.equal(cleanConversationAttachmentFilename("../../Client Brief.pdf"), "Client Brief.pdf");
  assert.equal(cleanConversationAttachmentFilename("C:\\fakepath\\site photo.jpg"), "site photo.jpg");
  assert.equal(
    conversationAttachmentStoragePath({
      conversationId: "conversation-1",
      userId: "user-1",
      attachmentId: "attachment-1",
      filename: "Client Brief.pdf",
    }),
    "conversations/conversation-1/attachments/user-1/attachment-1-client-brief.pdf"
  );
});

test("conversation attachment size and kind stay bounded", () => {
  assert.equal(isConversationAttachmentSize(1), true);
  assert.equal(isConversationAttachmentSize(MAX_CONVERSATION_ATTACHMENT_BYTES), true);
  assert.equal(isConversationAttachmentSize(MAX_CONVERSATION_ATTACHMENT_BYTES + 1), false);
  assert.equal(isConversationAttachmentSize(0), false);
  assert.equal(conversationAttachmentKind("image/jpeg"), "image");
  assert.equal(conversationAttachmentKind("application/pdf"), "document");
});
