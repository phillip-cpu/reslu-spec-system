import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import {
  cleanConversationAttachmentFilename,
  CONVERSATION_DIRECT_UPLOAD_MAX_BYTES,
  conversationAttachmentAccessUrl,
  conversationAttachmentStoragePath,
  isConversationAttachmentMime,
  isConversationAttachmentSize,
} from "@/lib/conversation-attachments";
import { inspectStorageObjectHead, sniffFileKind } from "@/lib/file-sniff";
import {
  isConversationVoiceNoteDuration,
  isConversationVoiceNoteMime,
  MAX_CONVERSATION_VOICE_NOTE_BYTES,
  voiceNoteMetadata,
} from "@/lib/conversation-voice-note";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import type { ConversationAttachment } from "@/types/conversations";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const EXPECTED_KIND: Record<ConversationAttachment["mime_type"], string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/mp4": "mp4",
  "audio/webm": "webm",
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ForwardedAttachmentRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  forwarded_by: string;
  storage_path: string;
  filename: string;
  mime_type: ConversationAttachment["mime_type"];
  byte_size: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

async function stagedAttachment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  userId: string,
  attachmentId: unknown
) {
  if (typeof attachmentId !== "string" || !attachmentId) return null;
  const { data } = await supabase
    .from("conversation_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("conversation_id", conversationId)
    .eq("uploaded_by", userId)
    .is("message_id", null)
    .maybeSingle();
  return data as ConversationAttachment | null;
}

async function accessibleReadyAttachment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  userId: string,
  attachmentId: unknown
) {
  if (typeof attachmentId !== "string" || !attachmentId) return null;
  const { data } = await supabase
    .from("conversation_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("conversation_id", conversationId)
    .eq("status", "ready")
    .maybeSingle();
  const attachment = data as ConversationAttachment | null;
  if (!attachment) return null;
  if (!attachment.message_id) return attachment.uploaded_by === userId ? attachment : null;
  const { data: message } = await supabase
    .from("conversation_messages")
    .select("deleted_at")
    .eq("id", attachment.message_id)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return message && !message.deleted_at ? attachment : null;
}

async function accessibleForwardedAttachment(
  memberSupabase: Awaited<ReturnType<typeof createClient>>,
  serviceSupabase: ReturnType<typeof createServiceRoleClient>,
  conversationId: string,
  userId: string,
  attachmentId: unknown
) {
  if (typeof attachmentId !== "string" || !UUID_PATTERN.test(attachmentId)) return null;
  const membership = await conversationParticipants(memberSupabase, conversationId, userId);
  const verifiedSelf = membership.participants.some((participant) => (
    participant.type === "human"
    && participant.id === userId
    && participant.is_self === true
  ));
  if (membership.error || !verifiedSelf) return null;
  const { data } = await serviceSupabase
    .from("conversation_forwarded_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  const attachment = data as ForwardedAttachmentRow | null;
  if (!attachment) return null;
  const { data: message } = await serviceSupabase
    .from("conversation_messages")
    .select("deleted_at")
    .eq("id", attachment.message_id)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return message && !message.deleted_at ? attachment : null;
}

function attachmentResponse(conversationId: string, attachment: ConversationAttachment) {
  return {
    ...attachment,
    metadata: attachment.metadata ?? {},
    url: attachment.status === "ready"
      ? conversationAttachmentAccessUrl(conversationId, attachment.id)
      : null,
  };
}

export async function GET(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await conversationParticipants(supabase, conversationId, user.id);
  if (membership.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  if (request.nextUrl.searchParams.get("drafts") === "1") {
    const { data, error } = await supabase
      .from("conversation_attachments")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("uploaded_by", user.id)
      .is("message_id", null)
      .in("status", ["uploading", "ready"])
      .order("created_at");
    if (error) return NextResponse.json({ error: "Could not restore attachment drafts" }, { status: 503 });
    return NextResponse.json({
      attachments: ((data ?? []) as ConversationAttachment[]).map((attachment) => (
        attachmentResponse(conversationId, attachment)
      )),
    });
  }

  const forwardedAttachmentId = request.nextUrl.searchParams.get("forwarded_attachment_id");
  if (forwardedAttachmentId) {
    const service = createServiceRoleClient();
    const forwarded = await accessibleForwardedAttachment(
      supabase,
      service,
      conversationId,
      user.id,
      forwardedAttachmentId
    );
    if (!forwarded) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    const { data: signed, error } = await service.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(forwarded.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) {
      return NextResponse.json({ error: "Could not open attachment" }, { status: 503 });
    }
    const requestedRange = request.headers.get("range");
    const storedObject = await fetch(signed.signedUrl, {
      cache: "no-store",
      headers: requestedRange ? { Range: requestedRange } : undefined,
    }).catch(() => null);
    if (!storedObject?.ok || !storedObject.body) {
      return NextResponse.json({ error: "Could not open attachment" }, { status: 503 });
    }
    const response = new NextResponse(storedObject.body, {
      status: storedObject.status === 206 ? 206 : 200,
      headers: {
        "Content-Type": forwarded.mime_type,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(forwarded.filename)}`,
      },
    });
    const contentLength = storedObject.headers.get("content-length");
    if (contentLength) response.headers.set("Content-Length", contentLength);
    const contentRange = storedObject.headers.get("content-range");
    if (contentRange) response.headers.set("Content-Range", contentRange);
    const acceptRanges = storedObject.headers.get("accept-ranges");
    if (acceptRanges) response.headers.set("Accept-Ranges", acceptRanges);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  const attachment = await accessibleReadyAttachment(
    supabase,
    conversationId,
    user.id,
    request.nextUrl.searchParams.get("attachment_id")
  );
  if (!attachment) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });

  const { data: signed, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(attachment.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not open attachment" }, { status: 503 });
  }
  const response = NextResponse.redirect(signed.signedUrl, 307);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function POST(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await conversationParticipants(supabase, conversationId, user.id);
  if (membership.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const requestedAttachmentId = form?.get("attachment_id");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a file to upload" }, { status: 400 });
    }
    if (typeof requestedAttachmentId !== "string" || !UUID_PATTERN.test(requestedAttachmentId)) {
      return NextResponse.json({ error: "The attachment upload id is invalid" }, { status: 400 });
    }
    const filename = cleanConversationAttachmentFilename(file.name);
    if (!filename) return NextResponse.json({ error: "Choose a file with a valid name" }, { status: 400 });
    if (!isConversationAttachmentMime(file.type)) {
      return NextResponse.json({ error: "Choose a JPEG, PNG, WebP, PDF or supported voice-note file" }, { status: 400 });
    }
    if (!isConversationAttachmentSize(file.size) || file.size > CONVERSATION_DIRECT_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: "This file must use the large-file uploader" }, { status: 413 });
    }

    const voiceNote = isConversationVoiceNoteMime(file.type);
    const rawDuration = form?.get("duration_ms");
    const durationMs = typeof rawDuration === "string" ? Number(rawDuration) : null;
    if (voiceNote && (form?.get("voice_note") !== "true" || !isConversationVoiceNoteDuration(durationMs))) {
      return NextResponse.json({ error: "Voice-note duration is invalid" }, { status: 400 });
    }
    if (voiceNote && file.size > MAX_CONVERSATION_VOICE_NOTE_BYTES) {
      return NextResponse.json({ error: "Voice notes must be no larger than 10 MB" }, { status: 400 });
    }
    if (!voiceNote && (form?.has("voice_note") || form?.has("duration_ms"))) {
      return NextResponse.json({ error: "Voice-note metadata does not match this file" }, { status: 400 });
    }

    const existing = await stagedAttachment(supabase, conversationId, user.id, requestedAttachmentId);
    if (existing?.status === "ready") {
      return NextResponse.json({ attachment: attachmentResponse(conversationId, existing) });
    }
    if (existing) {
      return NextResponse.json({
        error: "This attachment is still being stored",
        retryable: true,
      }, { status: 409 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const actualKind = sniffFileKind(bytes.subarray(0, 16));
    if (actualKind !== EXPECTED_KIND[file.type]) {
      return NextResponse.json({
        error: actualKind === "unknown"
          ? "The uploaded file contents could not be verified. Please choose it again."
          : "The file contents do not match its file type. Please check the file and try again.",
      }, { status: 400 });
    }

    const attachmentId = requestedAttachmentId;
    const storagePath = conversationAttachmentStoragePath({
      conversationId,
      userId: user.id,
      attachmentId,
      filename,
    });
    const { error: rowError } = await supabase.from("conversation_attachments").insert({
      id: attachmentId,
      conversation_id: conversationId,
      uploaded_by: user.id,
      storage_path: storagePath,
      filename,
      mime_type: file.type,
      byte_size: file.size,
      metadata: voiceNote ? voiceNoteMetadata(durationMs as number) : {},
    });
    if (rowError) {
      const raced = await stagedAttachment(supabase, conversationId, user.id, attachmentId);
      if (raced?.status === "ready") {
        return NextResponse.json({ attachment: attachmentResponse(conversationId, raced) });
      }
      return NextResponse.json({
        error: raced ? "This attachment is still being stored" : rowError.message,
        retryable: Boolean(raced),
      }, { status: raced ? 409 : 500 });
    }

    const { error: uploadError } = await supabase.storage.from(ASSET_BUCKET).upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) {
      await supabase.storage.from(ASSET_BUCKET).remove([storagePath]);
      await supabase.from("conversation_attachments").delete().eq("id", attachmentId);
      return NextResponse.json({ error: uploadError.message }, { status: 503 });
    }

    const { data: ready, error: readyError } = await supabase
      .from("conversation_attachments")
      .update({ status: "ready", ready_at: new Date().toISOString() })
      .eq("id", attachmentId)
      .select("*")
      .single();
    if (readyError || !ready) {
      // Preserve the bytes and staged row. The idempotent confirmation path
      // can complete it after a transient database response failure.
      return NextResponse.json({ error: readyError?.message ?? "Could not finish upload" }, { status: 503 });
    }
    return NextResponse.json({
      attachment: attachmentResponse(conversationId, ready as ConversationAttachment),
    }, { status: 201 });
  }

  const body = await request.json().catch(() => null);
  const attachment = await stagedAttachment(supabase, conversationId, user.id, body?.attachment_id);
  if (!attachment) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  if (attachment.status === "ready") {
    return NextResponse.json({ attachment: attachmentResponse(conversationId, attachment) });
  }

  const inspection = await inspectStorageObjectHead(supabase, ASSET_BUCKET, attachment.storage_path);
  if (!inspection || inspection.byteSize == null) {
    return NextResponse.json({
      error: "The uploaded file could not be verified yet. Please retry.",
    }, { status: 503 });
  }
  if (!isConversationAttachmentSize(inspection.byteSize) || inspection.byteSize !== attachment.byte_size) {
    await supabase.storage.from(ASSET_BUCKET).remove([attachment.storage_path]);
    await supabase.from("conversation_attachments").delete().eq("id", attachment.id);
    return NextResponse.json({
      error: "The uploaded file size did not match the selected file. Please choose it again.",
    }, { status: 400 });
  }

  const actualKind = sniffFileKind(inspection.bytes);
  if (actualKind !== EXPECTED_KIND[attachment.mime_type]) {
    await supabase.storage.from(ASSET_BUCKET).remove([attachment.storage_path]);
    await supabase.from("conversation_attachments").delete().eq("id", attachment.id);
    return NextResponse.json({
      error: actualKind === "unknown"
        ? "The uploaded file contents could not be verified. Please choose it again."
        : "The file contents do not match its file type. Please check the file and try again.",
    }, { status: 400 });
  }

  const { data: ready, error: updateError } = await supabase
    .from("conversation_attachments")
    .update({ status: "ready", ready_at: new Date().toISOString() })
    .eq("id", attachment.id)
    .select("*")
    .single();
  if (updateError || !ready) {
    return NextResponse.json({ error: updateError?.message ?? "Could not finish upload" }, { status: 500 });
  }

  return NextResponse.json({
    attachment: attachmentResponse(conversationId, ready as ConversationAttachment),
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await conversationParticipants(supabase, conversationId, user.id);
  if (membership.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const attachmentId = request.nextUrl.searchParams.get("attachment_id");
  const attachment = await stagedAttachment(supabase, conversationId, user.id, attachmentId);
  if (!attachment) return NextResponse.json({ ok: true });

  await supabase.storage.from(ASSET_BUCKET).remove([attachment.storage_path]);
  const { error } = await supabase.from("conversation_attachments").delete().eq("id", attachment.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
