import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import { conversationAttachmentAccessUrl } from "@/lib/conversation-attachments";
import {
  summarizeConversationMessageReactions,
  type ConversationMessageReactionRow,
} from "@/lib/conversation-message-engagement";
import { messageAuthor } from "@/lib/conversations";
import { createClient } from "@/lib/supabase/server";
import type { ConversationAttachment, ConversationMessage } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; messageId: string }> };
type MutationInput = {
  action?: unknown;
  body?: unknown;
  expected_version?: unknown;
};
type MessageRow = Omit<ConversationMessage, "attachments" | "author" | "reactions" | "pinned_at" | "pinned_by"> & {
  conversation_attachments?: ConversationAttachment[];
  conversation_message_reactions?: ConversationMessageReactionRow[];
  conversation_message_pins?: Array<{ pinned_at: string; pinned_by: string }>;
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mutationStatus(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/changed on another device|edit window|cannot be restored|deleted messages/i.test(message)) return 409;
  if (/invalid|required|unauthorized/i.test(message)) return 400;
  return 500;
}

async function hydratedMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  messageId: string,
  participants: Awaited<ReturnType<typeof conversationParticipants>>["participants"]
) {
  const { data, error } = await supabase
    .from("conversation_messages")
    .select("*, conversation_attachments(*), conversation_message_reactions(reaction,profile_id), conversation_message_pins(pinned_at,pinned_by)")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Message not found");
  const row = data as unknown as MessageRow;
  const attachments = (row.deleted_at ? [] : row.conversation_attachments ?? [])
    .filter((attachment) => attachment.status === "ready")
    .map((attachment) => ({
      ...attachment,
      metadata: attachment.metadata ?? {},
      url: conversationAttachmentAccessUrl(conversationId, attachment.id),
    }));
  const selfProfileId = participants.find((participant) => participant.is_self)?.id ?? null;
  const pin = row.deleted_at ? null : row.conversation_message_pins?.[0] ?? null;
  const reactions = row.deleted_at
    ? []
    : summarizeConversationMessageReactions(row.conversation_message_reactions ?? [], selfProfileId);
  const {
    conversation_attachments: _joinedAttachments,
    conversation_message_reactions: _joinedReactions,
    conversation_message_pins: _joinedPins,
    ...message
  } = row;
  return {
    ...message,
    metadata: message.metadata ?? {},
    attachments,
    reactions,
    pinned_at: pin?.pinned_at ?? null,
    pinned_by: pin?.pinned_by ?? null,
    author: messageAuthor(message, participants),
  } as ConversationMessage;
}

async function requestContext(context: Context) {
  const { id, messageId } = await context.params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) return null;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { unauthorized: true as const };
  const membership = await conversationParticipants(supabase, id, user.id);
  const self = membership.participants.some((participant) => participant.type === "human" && participant.id === user.id);
  if (membership.error || !self) return { notFound: true as const };
  return { id, messageId, supabase, participants: membership.participants };
}

export async function PATCH(request: NextRequest, context: Context) {
  const resolved = await requestContext(context);
  if (!resolved) return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  if ("unauthorized" in resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ("notFound" in resolved) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as MutationInput;
  const action = body.action === "restore" ? "restore" : "edit";
  let errorMessage: string | null = null;
  if (action === "restore") {
    const { error } = await resolved.supabase.rpc("restore_conversation_message", {
      p_conversation_id: resolved.id,
      p_message_id: resolved.messageId,
    });
    errorMessage = error?.message ?? null;
  } else {
    if (typeof body.body !== "string" || typeof body.expected_version !== "string" || Number.isNaN(Date.parse(body.expected_version))) {
      return NextResponse.json({ error: "Message text and version are required" }, { status: 400 });
    }
    const { error } = await resolved.supabase.rpc("edit_conversation_message", {
      p_conversation_id: resolved.id,
      p_message_id: resolved.messageId,
      p_body: body.body,
      p_expected_version: body.expected_version,
    });
    errorMessage = error?.message ?? null;
  }
  if (errorMessage) return NextResponse.json({ error: errorMessage }, { status: mutationStatus(errorMessage) });

  try {
    const message = await hydratedMessage(resolved.supabase, resolved.id, resolved.messageId, resolved.participants);
    return NextResponse.json({ message });
  } catch (reason) {
    return NextResponse.json({ error: reason instanceof Error ? reason.message : "Could not refresh message" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const resolved = await requestContext(context);
  if (!resolved) return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  if ("unauthorized" in resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ("notFound" in resolved) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const { error } = await resolved.supabase.rpc("delete_conversation_message_recoverably", {
    p_conversation_id: resolved.id,
    p_message_id: resolved.messageId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: mutationStatus(error.message) });

  try {
    const message = await hydratedMessage(resolved.supabase, resolved.id, resolved.messageId, resolved.participants);
    return NextResponse.json({ message });
  } catch (reason) {
    return NextResponse.json({ error: reason instanceof Error ? reason.message : "Could not refresh message" }, { status: 500 });
  }
}
