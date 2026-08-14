import { slugFilename } from "./storage.ts";

export const CONVERSATION_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "audio/mp4",
  "audio/webm",
] as const;

export type ConversationAttachmentMime = typeof CONVERSATION_ATTACHMENT_MIME_TYPES[number];

const CONVERSATION_ATTACHMENT_EXTENSION_MIME = new Map<string, ConversationAttachmentMime>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
]);

export const MAX_CONVERSATION_ATTACHMENTS = 6;
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Keep the complete multipart request below Vercel's request-body ceiling.
// Larger files retain the signed direct-to-Storage path.
export const CONVERSATION_DIRECT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const STAGED_CONVERSATION_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isConversationAttachmentMime(value: unknown): value is ConversationAttachmentMime {
  return typeof value === "string"
    && CONVERSATION_ATTACHMENT_MIME_TYPES.includes(value as ConversationAttachmentMime);
}

/**
 * Some iOS/Android file pickers return an empty MIME type or the non-standard
 * image/jpg alias for an otherwise valid photo. Resolve only formats already
 * accepted by the attachment boundary; the server still verifies the bytes.
 */
export function normalizeConversationAttachmentMime(
  filename: string,
  declaredMimeType: string
): ConversationAttachmentMime | null {
  const normalized = declaredMimeType.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (isConversationAttachmentMime(normalized)) return normalized;
  if (normalized && normalized !== "application/octet-stream") return null;
  const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? CONVERSATION_ATTACHMENT_EXTENSION_MIME.get(extension) ?? null : null;
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

export function conversationForwardedAttachmentAccessUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments?forwarded_attachment_id=${encodeURIComponent(attachmentId)}`;
}

export function isConversationAttachmentSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_CONVERSATION_ATTACHMENT_BYTES;
}

export function conversationAttachmentKind(mimeType: string): "image" | "document" | "audio" {
  if (mimeType.startsWith("image/")) return "image";
  return mimeType.startsWith("audio/") ? "audio" : "document";
}
