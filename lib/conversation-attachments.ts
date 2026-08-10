import { slugFilename } from "./storage.ts";

export const CONVERSATION_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type ConversationAttachmentMime = typeof CONVERSATION_ATTACHMENT_MIME_TYPES[number];

export const MAX_CONVERSATION_ATTACHMENTS = 6;
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const STAGED_CONVERSATION_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isConversationAttachmentMime(value: unknown): value is ConversationAttachmentMime {
  return typeof value === "string"
    && CONVERSATION_ATTACHMENT_MIME_TYPES.includes(value as ConversationAttachmentMime);
}

export function cleanConversationAttachmentFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const filename = value.trim().split(/[\\/]/).at(-1)?.trim() ?? "";
  return filename && filename.length <= 255 ? filename : null;
}

export function conversationAttachmentStoragePath(options: {
  conversationId: string;
  userId: string;
  attachmentId: string;
  filename: string;
}): string {
  const safeName = slugFilename(options.filename) || "attachment";
  return `conversations/${options.conversationId}/attachments/${options.userId}/${options.attachmentId}-${safeName}`;
}

export function conversationAttachmentAccessUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments?attachment_id=${encodeURIComponent(attachmentId)}`;
}

export function isConversationAttachmentSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_CONVERSATION_ATTACHMENT_BYTES;
}

export function conversationAttachmentKind(mimeType: string): "image" | "document" {
  return mimeType.startsWith("image/") ? "image" : "document";
}
