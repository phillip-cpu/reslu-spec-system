import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { conversationDisplayTitle, messageAuthor, sortConversations } from "@/lib/conversations";
import type {
  AgentSlug,
  ConversationMessage,
  ConversationParticipant,
  ConversationSummary,
} from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParticipantLink = {
  conversation_id: string;
  profile_id: string | null;
  agent_id: string | null;
  participant_role: "member" | "admin";
  profile: { id: string; full_name: string; avatar_url: string | null } | null;
  agent: { id: string; slug: AgentSlug; display_name: string; role_label: string; avatar_url: string | null } | null;
};

type ConversationInboxRow = {
  conversation_id: string;
  last_read_at: string | null;
  notifications_muted: boolean;
  archived_at: string | null;
  pinned_at: string | null;
  unread_count: number | string;
  last_message_id: string | null;
};

type ConversationContextRow = {
  conversation_id: string;
  scope_kind: "project" | "lead";
  project_id: string | null;
  lead_id: string | null;
  purpose_key: string;
  scope_label_snapshot: string;
  summary_updated_at: string | null;
};

function participantFromLink(link: ParticipantLink, userId: string): ConversationParticipant | null {
  if (link.profile) {
    return {
      id: link.profile.id,
      type: "human",
      display_name: link.profile.full_name,
      avatar_url: link.profile.avatar_url,
      is_self: link.profile.id === userId,
      is_admin: link.participant_role === "admin",
    };
  }
  if (link.agent) {
    return {
      id: link.agent.id,
      type: "agent",
      display_name: link.agent.display_name,
      avatar_url: link.agent.avatar_url,
      agent_slug: link.agent.slug,
      role_label: link.agent.role_label,
    };
  }
  return null;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [{ data: inboxRows, error: inboxError }, { data: profiles }, { data: agents }] = await Promise.all([
    supabase.rpc("get_conversation_inbox"),
    supabase.from("profiles").select("id,full_name,avatar_url").order("full_name"),
    supabase.from("conversation_agents").select("id,slug,display_name,role_label,avatar_url,auth_profile_id").eq("active", true).order("display_name"),
  ]);
  if (inboxError) return NextResponse.json({ error: inboxError.message }, { status: 500 });

  const inbox = new Map(
    ((inboxRows ?? []) as ConversationInboxRow[]).map((row) => [row.conversation_id, row])
  );
  const conversationIds = [...inbox.keys()];
  const lastMessageIds = [...new Set(
    ((inboxRows ?? []) as ConversationInboxRow[]).flatMap((row) => row.last_message_id ? [row.last_message_id] : [])
  )];
  const agentAuthProfileIds = new Set(
    (agents ?? []).map((agent) => agent.auth_profile_id).filter((id): id is string => Boolean(id))
  );
  const people: ConversationParticipant[] = [
    ...(profiles ?? []).filter((profile) => !agentAuthProfileIds.has(profile.id)).map((profile) => ({
      id: profile.id,
      type: "human" as const,
      display_name: profile.full_name,
      avatar_url: profile.avatar_url,
      is_self: profile.id === user.id,
    })),
    ...(agents ?? []).map((agent) => ({
      id: agent.id,
      type: "agent" as const,
      display_name: agent.display_name,
      avatar_url: agent.avatar_url,
      agent_slug: agent.slug as AgentSlug,
      role_label: agent.role_label,
    })),
  ];
  if (conversationIds.length === 0) return NextResponse.json({ conversations: [], people });

  const [{ data: conversations, error: conversationError }, { data: links }, { data: messages }, { data: contexts, error: contextError }] = await Promise.all([
    supabase.from("conversations").select("*").in("id", conversationIds).is("archived_at", null),
    supabase
      .from("conversation_participants")
      .select("conversation_id,profile_id,agent_id,participant_role,profile:profiles(id,full_name,avatar_url),agent:conversation_agents(id,slug,display_name,role_label,avatar_url)")
      .in("conversation_id", conversationIds),
    lastMessageIds.length > 0
      ? supabase
        .from("conversation_messages")
        .select("*")
        .in("id", lastMessageIds)
        .is("deleted_at", null)
      : Promise.resolve({ data: [] as ConversationMessage[] }),
    supabase
      .from("conversation_contexts")
      .select("conversation_id,scope_kind,project_id,lead_id,purpose_key,scope_label_snapshot,summary_updated_at")
      .in("conversation_id", conversationIds),
  ]);
  if (conversationError) return NextResponse.json({ error: conversationError.message }, { status: 500 });
  if (contextError) return NextResponse.json({ error: contextError.message }, { status: 500 });

  const contextByConversation = new Map(
    ((contexts ?? []) as ConversationContextRow[]).map((context) => [context.conversation_id, context])
  );

  const participantsByConversation = new Map<string, ConversationParticipant[]>();
  for (const rawLink of links ?? []) {
    const link = rawLink as unknown as ParticipantLink;
    const participant = participantFromLink(link, user.id);
    if (!participant) continue;
    const list = participantsByConversation.get(link.conversation_id) ?? [];
    list.push(participant);
    participantsByConversation.set(link.conversation_id, list);
  }

  const lastMessageByConversation = new Map<string, ConversationMessage>();
  for (const row of messages ?? []) {
    const participants = participantsByConversation.get(row.conversation_id) ?? [];
    lastMessageByConversation.set(row.conversation_id, {
      ...row,
      metadata: row.metadata ?? {},
      attachments: [],
      author: messageAuthor(row, participants),
    } as ConversationMessage);
  }

  const result: ConversationSummary[] = (conversations ?? []).map((conversation) => {
    const participants = participantsByConversation.get(conversation.id) ?? [];
    const context = contextByConversation.get(conversation.id) ?? null;
    return {
      ...conversation,
      unread_count: Number(inbox.get(conversation.id)?.unread_count ?? 0),
      notifications_muted: inbox.get(conversation.id)?.notifications_muted ?? false,
      archived_at: inbox.get(conversation.id)?.archived_at ?? null,
      pinned_at: inbox.get(conversation.id)?.pinned_at ?? null,
      participants,
      display_title: conversationDisplayTitle(conversation.title, participants, user.id),
      last_message: lastMessageByConversation.get(conversation.id) ?? null,
      context: context ? {
        scope_kind: context.scope_kind,
        scope_id: context.project_id ?? context.lead_id!,
        purpose_key: context.purpose_key,
        scope_label: context.scope_label_snapshot,
        summary_updated_at: context.summary_updated_at,
      } : null,
    } as ConversationSummary;
  });

  return NextResponse.json({ conversations: sortConversations(result), people });
}

export async function POST(request: NextRequest) {
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
  const body = rawBody as {
    title?: unknown;
    profile_ids?: unknown;
    agent_slugs?: unknown;
    client_conversation_id?: unknown;
  };
  if (body.title != null && typeof body.title !== "string") {
    return NextResponse.json({ error: "Invalid conversation title" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length > 200) {
    return NextResponse.json({ error: "Conversation title is too long" }, { status: 400 });
  }
  if (body.profile_ids != null && !Array.isArray(body.profile_ids)) {
    return NextResponse.json({ error: "Invalid profile ids" }, { status: 400 });
  }
  const rawProfileIds = (body.profile_ids ?? []) as unknown[];
  if (
    rawProfileIds.length > 49
    || rawProfileIds.some((value) => typeof value !== "string" || !UUID_PATTERN.test(value))
    || rawProfileIds.length !== new Set(rawProfileIds).size
  ) {
    return NextResponse.json({ error: "Profile ids must be unique valid UUIDs" }, { status: 400 });
  }
  const profileIds = rawProfileIds as string[];
  if (body.agent_slugs != null && !Array.isArray(body.agent_slugs)) {
    return NextResponse.json({ error: "Invalid agent slugs" }, { status: 400 });
  }
  const rawAgentSlugs = (body.agent_slugs ?? []) as unknown[];
  if (
    rawAgentSlugs.length > 3
    || rawAgentSlugs.some((value) => value !== "aria" && value !== "marco" && value !== "stuart")
    || rawAgentSlugs.length !== new Set(rawAgentSlugs).size
  ) {
    return NextResponse.json({ error: "Agent slugs must be unique Aria, Marco or Stuart values" }, { status: 400 });
  }
  const agentSlugs = rawAgentSlugs as AgentSlug[];
  if (profileIds.filter((profileId) => profileId !== user.id).length + agentSlugs.length < 1) {
    return NextResponse.json({ error: "Choose at least one other person or agent" }, { status: 400 });
  }
  if (body.client_conversation_id != null && (
    typeof body.client_conversation_id !== "string"
    || !UUID_PATTERN.test(body.client_conversation_id)
  )) {
    return NextResponse.json({ error: "Invalid client conversation id" }, { status: 400 });
  }
  const clientConversationId = typeof body.client_conversation_id === "string"
    ? body.client_conversation_id
    : crypto.randomUUID();

  const { data, error } = await supabase.rpc("create_conversation_idempotent", {
    p_title: title || null,
    p_profile_ids: profileIds,
    p_agent_slugs: agentSlugs,
    p_client_conversation_id: clientConversationId,
  }).single();
  const created = data as { conversation_id: string; existing: boolean } | null;
  if (error || !created) {
    const message = error?.message ?? "Could not create conversation";
    const status = /unavailable|invalid|required|too (?:many|long)|choose|unique/i.test(message)
      ? 400
      : /already used/i.test(message)
        ? 409
        : 500;
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json(
    { id: created.conversation_id, existing: Boolean(created.existing) },
    { status: created.existing ? 200 : 201 }
  );
}
