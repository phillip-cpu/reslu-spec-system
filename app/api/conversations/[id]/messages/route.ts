import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { messageAuthor } from "@/lib/conversations";
import { conversationParticipants } from "@/lib/conversation-access";
import {
  conversationAttachmentAccessUrl,
  conversationForwardedAttachmentAccessUrl,
  MAX_CONVERSATION_ATTACHMENTS,
} from "@/lib/conversation-attachments";
import {
  summarizeConversationMessageReactions,
  type ConversationMessageReactionRow,
} from "@/lib/conversation-message-engagement";
import type {
  AgentSlug,
  ConversationAgentActivity,
  ConversationAttachment,
  ConversationMessage,
  ConversationParticipant,
} from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_SLUGS = new Set<AgentSlug>(["aria", "marco", "stuart"]);
type MessageInput = {
  body?: unknown;
  source?: unknown;
  target_agent_slugs?: unknown;
  attachment_ids?: unknown;
  client_message_id?: unknown;
  reply_to_id?: unknown;
};
type MessageRow = Omit<ConversationMessage, "attachments" | "author" | "reactions" | "pinned_at" | "pinned_by"> & {
  conversation_attachments?: ConversationAttachment[];
  forwarded_attachments?: Array<{
    id: string;
    conversation_id: string;
    message_id: string;
    forwarded_by: string;
    filename: string;
    mime_type: ConversationAttachment["mime_type"];
    byte_size: number;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  conversation_message_reactions?: ConversationMessageReactionRow[];
  conversation_message_pins?: Array<{ pinned_at: string; pinned_by: string }>;
};
const MESSAGE_SELECT = "*, conversation_attachments(*), forwarded_attachments:conversation_forwarded_attachments(id,conversation_id,message_id,forwarded_by,filename,mime_type,byte_size,metadata,created_at), conversation_message_reactions(reaction,profile_id), conversation_message_pins(pinned_at,pinned_by)";
type ActiveAgentJobRow = {
  agent_id: string;
  status: "pending" | "processing";
  created_at: string;
  claimed_at: string | null;
  progress_label: string | null;
  progress_updated_at: string | null;
};

function hydrateMessages(
  rows: MessageRow[],
  participants: ConversationParticipant[],
  conversationId: string
): ConversationMessage[] {
  const selfProfileId = participants.find((participant) => participant.is_self)?.id ?? null;
  return rows.map((row) => {
    const uploadedAttachments = (row.deleted_at ? [] : row.conversation_attachments ?? [])
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => ({
        ...attachment,
        metadata: attachment.metadata ?? {},
        url: conversationAttachmentAccessUrl(conversationId, attachment.id),
      }));
    const forwardedAttachments: ConversationAttachment[] = (row.deleted_at ? [] : row.forwarded_attachments ?? [])
      .map((attachment) => ({
        id: attachment.id,
        conversation_id: attachment.conversation_id,
        message_id: attachment.message_id,
        uploaded_by: attachment.forwarded_by,
        storage_path: "",
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        byte_size: attachment.byte_size,
        status: "ready",
        metadata: attachment.metadata ?? {},
        created_at: attachment.created_at,
        ready_at: attachment.created_at,
        url: conversationForwardedAttachmentAccessUrl(conversationId, attachment.id),
        forwarded: true,
      }));
    const attachments = [...uploadedAttachments, ...forwardedAttachments]
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    const pin = row.deleted_at ? null : row.conversation_message_pins?.[0] ?? null;
    const reactions = row.deleted_at
      ? []
      : summarizeConversationMessageReactions(row.conversation_message_reactions ?? [], selfProfileId);
    const {
      conversation_attachments: _joinedAttachments,
      forwarded_attachments: _joinedForwardedAttachments,
      conversation_message_reactions: _joinedReactions,
      conversation_message_pins: _joinedPins,
      ...messageRow
    } = row;
    return {
      ...messageRow,
      metadata: row.metadata ?? {},
      attachments,
      reactions,
      pinned_at: pin?.pinned_at ?? null,
      pinned_by: pin?.pinned_by ?? null,
      author: messageAuthor(row, participants),
    };
  });
}

async function activeAgentActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  participants: ConversationParticipant[]
): Promise<ConversationAgentActivity[]> {
  const agentIds = new Set(participants.filter((participant) => participant.type === "agent").map((participant) => participant.id));
  if (agentIds.size === 0) return [];
  const { data, error } = await supabase
    .from("agent_conversation_jobs")
    .select("agent_id,status,created_at,claimed_at,progress_label,progress_updated_at")
    .eq("conversation_id", conversationId)
    .in("status", ["pending", "processing"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.error("Could not load active conversation agent work", { conversationId, error: error.message });
    return [];
  }
  const activity = new Map<string, ConversationAgentActivity>();
  for (const job of (data ?? []) as ActiveAgentJobRow[]) {
    if (!agentIds.has(job.agent_id)) continue;
    const current = activity.get(job.agent_id);
    if (!current) {
      activity.set(job.agent_id, {
        agent_id: job.agent_id,
        status: job.status,
        pending_turns: 1,
        queued_at: job.created_at,
        claimed_at: job.claimed_at,
        progress_label: job.progress_label,
        progress_updated_at: job.progress_updated_at,
      });
      continue;
    }
    current.pending_turns += 1;
    if (job.status === "processing") {
      current.status = "processing";
      current.claimed_at = job.claimed_at;
      current.progress_label = job.progress_label;
      current.progress_updated_at = job.progress_updated_at;
    }
  }
  return [...activity.values()];
}

async function pinnedConversationMessages(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  participants: ConversationParticipant[]
): Promise<ConversationMessage[]> {
  const { data: pins, error: pinError } = await supabase
    .from("conversation_message_pins")
    .select("message_id,pinned_at")
    .eq("conversation_id", conversationId)
    .order("pinned_at", { ascending: false })
    .limit(5);
  if (pinError || !pins?.length) {
    if (pinError) console.error("Could not load pinned conversation messages", { conversationId, error: pinError.message });
    return [];
  }
  const { data: rows, error } = await supabase
    .from("conversation_messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", conversationId)
    .in("id", pins.map((pin) => pin.message_id))
    .is("deleted_at", null);
  if (error) {
    console.error("Could not hydrate pinned conversation messages", { conversationId, error: error.message });
    return [];
  }
  const hydrated = new Map(
    hydrateMessages((rows ?? []) as unknown as MessageRow[], participants, conversationId)
      .map((message) => [message.id, message])
  );
  return pins.flatMap((pin) => hydrated.get(pin.message_id) ?? []);
}

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const participantResult = await conversationParticipants(supabase, id, user.id);
  if (participantResult.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const clientMessageId = request.nextUrl.searchParams.get("client_message_id");
  if (clientMessageId && !UUID_PATTERN.test(clientMessageId)) {
    return NextResponse.json({ error: "Invalid client message id" }, { status: 400 });
  }
  if (clientMessageId) {
    // A mobile connection can lose the POST response after Postgres has
    // already committed the message. Resolve that ambiguity against the
    // canonical row so the device can clear its outbox without duplicating
    // the send or asking the user to retry a message that was delivered.
    const { data: canonicalMessage, error: canonicalMessageError } = await supabase
      .from("conversation_messages")
      .select("id")
      .eq("conversation_id", id)
      .eq("author_profile_id", user.id)
      .eq("client_message_id", clientMessageId)
      .maybeSingle();
    if (canonicalMessageError) {
      return NextResponse.json({ error: canonicalMessageError.message }, { status: 500 });
    }
    return NextResponse.json({ canonical_message_id: canonicalMessage?.id ?? null });
  }

  const [agentActivity, pinnedMessages] = await Promise.all([
    activeAgentActivity(supabase, id, participantResult.participants),
    pinnedConversationMessages(supabase, id, participantResult.participants),
  ]);

  const around = request.nextUrl.searchParams.get("around");
  if (around && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(around)) {
    return NextResponse.json({ error: "Invalid message anchor" }, { status: 400 });
  }
  if (around) {
    const { data: targetData, error: targetError } = await supabase
      .from("conversation_messages")
      .select(MESSAGE_SELECT)
      .eq("conversation_id", id)
      .eq("id", around)
      .maybeSingle();
    if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 });
    if (!targetData) return NextResponse.json({ error: "Message not found" }, { status: 404 });

    const [olderResult, newerResult] = await Promise.all([
      supabase
        .from("conversation_messages")
        .select(MESSAGE_SELECT)
        .eq("conversation_id", id)
        .or(`created_at.lt.${targetData.created_at},and(created_at.eq.${targetData.created_at},id.lt.${around})`)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(50),
      supabase
        .from("conversation_messages")
        .select(MESSAGE_SELECT)
        .eq("conversation_id", id)
        .or(`created_at.gt.${targetData.created_at},and(created_at.eq.${targetData.created_at},id.gt.${around})`)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(50),
    ]);
    const contextError = olderResult.error ?? newerResult.error;
    if (contextError) return NextResponse.json({ error: contextError.message }, { status: 500 });
    const rows = [
      ...((olderResult.data ?? []) as unknown as MessageRow[]).reverse(),
      targetData as unknown as MessageRow,
      ...((newerResult.data ?? []) as unknown as MessageRow[]),
    ];
    return NextResponse.json({
      messages: hydrateMessages(rows, participantResult.participants, id),
      participants: participantResult.participants,
      agent_activity: agentActivity,
      pinned_messages: pinnedMessages,
      context: { anchor_message_id: around, has_older: (olderResult.data?.length ?? 0) === 50, has_newer: (newerResult.data?.length ?? 0) === 50 },
    });
  }

  const before = request.nextUrl.searchParams.get("before");
  const beforeId = request.nextUrl.searchParams.get("before_id");
  if (before && Number.isNaN(Date.parse(before))) {
    return NextResponse.json({ error: "Invalid message cursor" }, { status: 400 });
  }
  if (beforeId && !UUID_PATTERN.test(beforeId)) {
    return NextResponse.json({ error: "Invalid message cursor" }, { status: 400 });
  }
  if (beforeId && !before) {
    return NextResponse.json({ error: "Incomplete message cursor" }, { status: 400 });
  }
  let query = supabase
    .from("conversation_messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (before && beforeId) {
    query = query.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`);
  } else if (before) {
    // Compatibility for clients deployed before the composite cursor.
    query = query.lt("created_at", before);
  }
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = ((data ?? []) as unknown as MessageRow[]).reverse();
  return NextResponse.json({
    messages: hydrateMessages(rows, participantResult.participants, id),
    participants: participantResult.participants,
    agent_activity: agentActivity,
    pinned_messages: pinnedMessages,
    context: { anchor_message_id: null, has_older: (data?.length ?? 0) === 100, has_newer: false },
  });
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as MessageInput;
  if (body.body != null && typeof body.body !== "string") {
    return NextResponse.json({ error: "Invalid message body" }, { status: 400 });
  }
  if (body.source != null && body.source !== "text" && body.source !== "voice" && body.source !== "voice_note") {
    return NextResponse.json({ error: "Invalid message source" }, { status: 400 });
  }
  if (body.target_agent_slugs != null && !Array.isArray(body.target_agent_slugs)) {
    return NextResponse.json({ error: "Invalid agent targets" }, { status: 400 });
  }
  const rawTargetAgentSlugs = (body.target_agent_slugs ?? []) as unknown[];
  if (
    rawTargetAgentSlugs.length > AGENT_SLUGS.size
    || rawTargetAgentSlugs.some((value) => typeof value !== "string" || !AGENT_SLUGS.has(value as AgentSlug))
    || rawTargetAgentSlugs.length !== new Set(rawTargetAgentSlugs).size
  ) {
    return NextResponse.json({ error: "Agent targets must be unique Aria, Marco or Stuart values" }, { status: 400 });
  }
  const targetAgentSlugs = rawTargetAgentSlugs as AgentSlug[];
  if (body.attachment_ids != null && !Array.isArray(body.attachment_ids)) {
    return NextResponse.json({ error: "Invalid attachment ids" }, { status: 400 });
  }
  const rawAttachmentIds = (body.attachment_ids ?? []) as unknown[];
  if (rawAttachmentIds.some((value) => typeof value !== "string" || !UUID_PATTERN.test(value))) {
    return NextResponse.json({ error: "Invalid attachment ids" }, { status: 400 });
  }
  const attachmentIds = rawAttachmentIds as string[];
  if (attachmentIds.length !== new Set(attachmentIds).size || attachmentIds.length > MAX_CONVERSATION_ATTACHMENTS) {
    return NextResponse.json({ error: `Attach no more than ${MAX_CONVERSATION_ATTACHMENTS} unique files` }, { status: 400 });
  }
  const typedBody = typeof body.body === "string" ? body.body.trim() : "";
  if (!typedBody && attachmentIds.length === 0) {
    return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 });
  }
  const messageBody = typedBody || `Shared ${attachmentIds.length} attachment${attachmentIds.length === 1 ? "" : "s"}`;
  if (messageBody.length > 20000) return NextResponse.json({ error: "Message is too long" }, { status: 400 });
  if (body.client_message_id != null && typeof body.client_message_id !== "string") {
    return NextResponse.json({ error: "Invalid client message id" }, { status: 400 });
  }
  const suppliedClientMessageId = typeof body.client_message_id === "string" ? body.client_message_id.trim() : "";
  if (suppliedClientMessageId && !UUID_PATTERN.test(suppliedClientMessageId)) {
    return NextResponse.json({ error: "Invalid client message id" }, { status: 400 });
  }
  const clientMessageId = suppliedClientMessageId || crypto.randomUUID();
  if (body.reply_to_id != null && typeof body.reply_to_id !== "string") {
    return NextResponse.json({ error: "Invalid reply target" }, { status: 400 });
  }
  const replyToId = body.reply_to_id == null ? null : body.reply_to_id.trim();
  if (replyToId && !UUID_PATTERN.test(replyToId)) {
    return NextResponse.json({ error: "Invalid reply target" }, { status: 400 });
  }

  const participantResult = await conversationParticipants(supabase, id, user.id);
  const self = participantResult.participants.find((participant) => participant.type === "human" && participant.id === user.id);
  if (!self) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const agents = participantResult.participants.filter((participant) => participant.type === "agent");
  let replyTargetAgentId: string | null = null;
  if (replyToId) {
    const { data: replyTarget, error: replyTargetError } = await supabase
      .from("conversation_messages")
      .select("author_agent_id")
      .eq("id", replyToId)
      .eq("conversation_id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (replyTargetError) return NextResponse.json({ error: replyTargetError.message }, { status: 500 });
    replyTargetAgentId = replyTarget?.author_agent_id ?? null;
  }
  const explicitTargets = new Set(targetAgentSlugs);
  const mentionedTargets = agents.filter((agent) => {
    const slug = agent.agent_slug!;
    return agent.id === replyTargetAgentId
      || explicitTargets.has(slug)
      || new RegExp(`(?:^|\\s)@?${agent.display_name}(?:\\s|[,.!?]|$)`, "i").test(messageBody);
  });
  const targetAgents = agents.length === 1 && participantResult.participants.length === 2 && explicitTargets.size === 0
    ? agents
    : mentionedTargets;
  if (body.source === "voice" && targetAgents.length > 0) {
    // A newer spoken turn supersedes unfinished speech. The Mac bridge
    // checks this state before publishing output, so a late reply cannot
    // appear after the interruption. Any business side effect already
    // completed by the agent remains real and auditable.
    const { error: cancellationError } = await supabase.rpc("cancel_agent_conversation_jobs", {
      p_conversation_id: id,
      p_agent_ids: targetAgents.map((agent) => agent.id),
    });
    if (cancellationError) {
      console.error("could not establish voice-turn cancellation boundary", {
        conversationId: id,
        agentSlugs: targetAgents.map((agent) => agent.agent_slug),
        error: cancellationError.message,
      });
      return NextResponse.json({
        error: "The previous voice turn could not be interrupted safely. Please try again.",
      }, { status: 503 });
    }
  }

  const metadata = {
    source: body.source === "voice" ? "voice" : body.source === "voice_note" ? "voice_note" : "text",
    target_agent_slugs: targetAgents.map((agent) => agent.agent_slug),
    ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
  };
  const messageResult = await supabase.rpc("create_conversation_message_idempotent", {
    p_conversation_id: id,
    p_body: messageBody,
    p_metadata: metadata,
    p_client_message_id: clientMessageId,
    p_attachment_ids: attachmentIds,
    p_reply_to_id: replyToId,
  }).single();
  const { data: rawMessage, error } = messageResult;
  const message = rawMessage as unknown as ConversationMessage | null;
  if (error || !message) {
    const errorMessage = error?.message ?? "Could not send message";
    const conflict = /client message id|reply target|attachments? (?:changed|set does not match|are unavailable)/i.test(errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: conflict ? 409 : 500 });
  }

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
    message: {
      ...message,
      metadata: message.metadata ?? {},
      attachments: [],
      reactions: [],
      pinned_at: null,
      pinned_by: null,
      author: self,
    },
    queued_agents: targetAgents.map((agent) => agent.agent_slug),
    queue_error: queueError,
  }, { status: 201 });
}
