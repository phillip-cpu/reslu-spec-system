import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import { conversationAttachmentAccessUrl } from "@/lib/conversation-attachments";
import { sniffFileKind } from "@/lib/file-sniff";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { sniffStorageObjectHead } from "@/lib/file-sniff";
import { createClient } from "@/lib/supabase/server";
import type { ConversationAttachment } from "@/types/conversations";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const EXPECTED_KIND: Record<ConversationAttachment["mime_type"], string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
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

async function readyMessageAttachment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  attachmentId: unknown
) {
  if (typeof attachmentId !== "string" || !attachmentId) return null;
  const { data } = await supabase
    .from("conversation_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("conversation_id", conversationId)
    .eq("status", "ready")
    .not("message_id", "is", null)
    .maybeSingle();
  return data as ConversationAttachment | null;
}

export async function GET(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await conversationParticipants(supabase, conversationId, user.id);
  if (membership.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const attachment = await readyMessageAttachment(
    supabase,
    conversationId,
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

  const body = await request.json().catch(() => null);
  const attachment = await stagedAttachment(supabase, conversationId, user.id, body?.attachment_id);
  if (!attachment) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });

  const head = await sniffStorageObjectHead(supabase, ASSET_BUCKET, attachment.storage_path);
  const actualKind = head ? sniffFileKind(head) : "unknown";
  if (actualKind !== EXPECTED_KIND[attachment.mime_type]) {
    await supabase.storage.from(ASSET_BUCKET).remove([attachment.storage_path]);
    await supabase.from("conversation_attachments").delete().eq("id", attachment.id);
    return NextResponse.json({
      error: actualKind === "unknown"
        ? "The uploaded file could not be verified. Please choose it again."
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
    attachment: {
      ...ready,
      metadata: ready.metadata ?? {},
      url: conversationAttachmentAccessUrl(conversationId, ready.id),
    },
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
