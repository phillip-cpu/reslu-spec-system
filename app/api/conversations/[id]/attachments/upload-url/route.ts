import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import {
  cleanConversationAttachmentFilename,
  conversationAttachmentStoragePath,
  isConversationAttachmentMime,
  isConversationAttachmentSize,
  STAGED_CONVERSATION_ATTACHMENT_MAX_AGE_MS,
} from "@/lib/conversation-attachments";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await conversationParticipants(supabase, conversationId, user.id);
  if (membership.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  // A browser can disappear halfway through a signed upload. Clear this
  // user's old, incomplete objects on their next upload so interrupted
  // attempts cannot accumulate forever. Verified ready drafts are retained
  // until the user sends or explicitly removes them.
  const staleBefore = new Date(Date.now() - STAGED_CONVERSATION_ATTACHMENT_MAX_AGE_MS).toISOString();
  const { data: staleRows } = await supabase
    .from("conversation_attachments")
    .select("id,storage_path")
    .eq("conversation_id", conversationId)
    .eq("uploaded_by", user.id)
    .is("message_id", null)
    .eq("status", "uploading")
    .lt("created_at", staleBefore);
  if (staleRows?.length) {
    const stalePaths = staleRows.map((row) => row.storage_path);
    const { error: staleStorageError } = await supabase.storage.from(ASSET_BUCKET).remove(stalePaths);
    if (!staleStorageError) {
      await supabase.from("conversation_attachments").delete().in("id", staleRows.map((row) => row.id));
    }
  }

  const body = await request.json().catch(() => null);
  const filename = cleanConversationAttachmentFilename(body?.filename);
  const mimeType = body?.mime_type;
  const byteSize = body?.byte_size;
  if (!filename) return NextResponse.json({ error: "Choose a file with a valid name" }, { status: 400 });
  if (!isConversationAttachmentMime(mimeType)) {
    return NextResponse.json({ error: "Choose a JPEG, PNG, WebP or PDF file" }, { status: 400 });
  }
  if (!isConversationAttachmentSize(byteSize)) {
    return NextResponse.json({ error: "Attachments must be between 1 byte and 25 MB" }, { status: 400 });
  }

  const attachmentId = randomUUID();
  const path = conversationAttachmentStoragePath({
    conversationId,
    userId: user.id,
    attachmentId,
    filename,
  });
  const { error: rowError } = await supabase.from("conversation_attachments").insert({
    id: attachmentId,
    conversation_id: conversationId,
    uploaded_by: user.id,
    storage_path: path,
    filename,
    mime_type: mimeType,
    byte_size: byteSize,
  });
  if (rowError) return NextResponse.json({ error: rowError.message }, { status: 500 });

  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    await supabase.from("conversation_attachments").delete().eq("id", attachmentId);
    return NextResponse.json({ error: error?.message ?? "Could not start upload" }, { status: 500 });
  }

  return NextResponse.json({ attachment_id: attachmentId, path: data.path, token: data.token });
}
