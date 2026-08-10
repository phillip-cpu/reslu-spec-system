import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { messageAuthor } from "@/lib/conversations";
import { conversationParticipants } from "@/lib/conversation-access";
import { conversationAttachmentAccessUrl, MAX_CONVERSATION_ATTACHMENTS } from "@/lib/conversation-attachments";
import type { AgentSlug, ConversationAttachment, ConversationMessage } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const participantResult = await conversationParticipants(supabase, id, user.id);
  if (participantResult.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const before = request.nextUrl.searchParams.get("before");
  let query = supabase
    .from("conversation_messages")
    .select("*, conversation_attachments(*)")
    .eq("conversation_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).reverse();
  const messages = rows.map((row) => {
    const attachments = ((row.conversation_attachments ?? []) as ConversationAttachment[])
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => ({
        ...attachment,
        metadata: attachment.metadata ?? {},
        url: conversationAttachmentAccessUrl(id, attachment.id),
      }));
    const { conversation_attachments: _joinedAttachments, ...messageRow } = row;
    return {
      ...messageRow,
      metadata: row.metadata ?? {},
      attachments,
      author: messageAuthor(row, participantResult.participants),
    };
  }) as ConversationMessage[];
  return NextResponse.json({ messages, participants: participantResult.participants });
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    body?: string;
    source?: "text" | "voice";
    target_agent_slugs?: AgentSlug[];
    attachment_ids?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (attachmentIds.length !== new Set(attachmentIds).size || attachmentIds.length > MAX_CONVERSATION_ATTACHMENTS) {
    return NextResponse.json({ error: `Attach no more than ${MAX_CONVERSATION_ATTACHMENTS} unique files` }, { status: 400 });
  }
  const typedBody = body.body?.trim() ?? "";
  if (!typedBody && attachmentIds.length === 0) {
    return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 });
  }
  const messageBody = typedBody || `Shared ${attachmentIds.length} attachment${attachmentIds.length === 1 ? "" : "s"}`;
  if (messageBody.length > 20000) return NextResponse.json({ error: "Message is too long" }, { status: 400 });

  const participantResult = await conversationParticipants(supabase, id, user.id);
  const self = participantResult.participants.find((participant) => participant.type === "human" && participant.id === user.id);
  if (!self) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const agents = participantResult.participants.filter((participant) => participant.type === "agent");
  const explicitTargets = new Set(body.target_agent_slugs ?? []);
  const mentionedTargets = agents.filter((agent) => {
    const slug = agent.agent_slug!;
    return explicitTargets.has(slug) || new RegExp(`(?:^|\\s)@?${agent.display_name}(?:\\s|[,.!?]|$)`, "i").test(messageBody);
  });
  const targetAgents = agents.length === 1 && participantResult.participants.length === 2 && explicitTargets.size === 0
    ? agents
    : mentionedTargets;
  if (body.source === "voice" && targetAgents.length > 0) {
    // A newer spoken turn supersedes unfinished speech. The Mac bridge
    // checks this state before publishing output, so a late reply cannot
    // appear after the interruption. Any business side effect already
    // completed by the agent remains real and auditable.
    await supabase.rpc("cancel_agent_conversation_jobs", {
      p_conversation_id: id,
      p_agent_ids: targetAgents.map((agent) => agent.id),
    });
  }

  const metadata = {
    source: body.source === "voice" ? "voice" : "text",
    target_agent_slugs: targetAgents.map((agent) => agent.agent_slug),
    ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
  };
  const messageResult = attachmentIds.length > 0
    ? await supabase.rpc("create_conversation_message_with_attachments", {
        p_conversation_id: id,
        p_body: messageBody,
        p_metadata: metadata,
        p_attachment_ids: attachmentIds,
      }).single()
    : await supabase
        .from("conversation_messages")
        .insert({
          conversation_id: id,
          author_profile_id: user.id,
          body: messageBody,
          metadata,
        })
        .select("*")
        .single();
  const { data: message, error } = messageResult;
  if (error || !message) return NextResponse.json({ error: error?.message ?? "Could not send message" }, { status: 500 });

  let queueError: string | null = null;
  if (targetAgents.length > 0) {
    // Migration 090 enqueues this atomically from the message insert. Keep
    // this idempotent upsert as a compatibility path while Vercel and the
    // database migration roll out in either order.
    const { error: jobError } = await supabase.from("agent_conversation_jobs").upsert(
      targetAgents.map((agent) => ({
        conversation_id: id,
        triggering_message_id: message.id,
        agent_id: agent.id,
      })),
      { onConflict: "triggering_message_id,agent_id", ignoreDuplicates: true }
    );
    if (jobError) {
      queueError = jobError.message;
      console.error("conversation message saved but agent enqueue failed", {
        conversationId: id,
        messageId: message.id,
        agentSlugs: targetAgents.map((agent) => agent.agent_slug),
        error: jobError.message,
      });
    }
  }

  return NextResponse.json({
    message: { ...message, metadata: message.metadata ?? {}, attachments: [], author: self },
    queued_agents: targetAgents.map((agent) => agent.agent_slug),
    queue_error: queueError,
  }, { status: 201 });
}
