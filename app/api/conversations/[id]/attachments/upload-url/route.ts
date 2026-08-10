import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import {
  cleanConversationAttachmentFilename,
  conversationAttachmentStoragePath,
  isConversationAttachmentMime,
  isConversationAttachmentSize,
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
