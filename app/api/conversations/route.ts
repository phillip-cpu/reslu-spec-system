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

type ParticipantLink = {
  conversation_id: string;
  profile_id: string | null;
  agent_id: string | null;
  profile: { id: string; full_name: string; avatar_url: string | null } | null;
  agent: { id: string; slug: AgentSlug; display_name: string; role_label: string; avatar_url: string | null } | null;
};

function participantFromLink(link: ParticipantLink, userId: string): ConversationParticipant | null {
  if (link.profile) {
    return {
      id: link.profile.id,
      type: "human",
      display_name: link.profile.full_name,
      avatar_url: link.profile.avatar_url,
      is_self: link.profile.id === userId,
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

  const [{ data: ownLinks, error: ownError }, { data: profiles }, { data: agents }] = await Promise.all([
    supabase.from("conversation_participants").select("conversation_id").eq("profile_id", user.id),
    supabase.from("profiles").select("id,full_name,avatar_url").order("full_name"),
    supabase.from("conversation_agents").select("id,slug,display_name,role_label,avatar_url,auth_profile_id").eq("active", true).order("display_name"),
  ]);
  if (ownError) return NextResponse.json({ error: ownError.message }, { status: 500 });

  const conversationIds = (ownLinks ?? []).map((link) => link.conversation_id);
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

  const [{ data: conversations, error: conversationError }, { data: links }, { data: messages }] = await Promise.all([
    supabase.from("conversations").select("*").in("id", conversationIds).is("archived_at", null),
    supabase
      .from("conversation_participants")
      .select("conversation_id,profile_id,agent_id,profile:profiles(id,full_name,avatar_url),agent:conversation_agents(id,slug,display_name,role_label,avatar_url)")
      .in("conversation_id", conversationIds),
    supabase
      .from("conversation_messages")
      .select("*")
      .in("conversation_id", conversationIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(500, conversationIds.length * 10)),
  ]);
  if (conversationError) return NextResponse.json({ error: conversationError.message }, { status: 500 });

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
    if (lastMessageByConversation.has(row.conversation_id)) continue;
    const participants = participantsByConversation.get(row.conversation_id) ?? [];
    lastMessageByConversation.set(row.conversation_id, {
      ...row,
      metadata: row.metadata ?? {},
      author: messageAuthor(row, participants),
    } as ConversationMessage);
  }

  const result: ConversationSummary[] = (conversations ?? []).map((conversation) => {
    const participants = participantsByConversation.get(conversation.id) ?? [];
    return {
      ...conversation,
      participants,
      display_title: conversationDisplayTitle(conversation.title, participants, user.id),
      last_message: lastMessageByConversation.get(conversation.id) ?? null,
    } as ConversationSummary;
  });

  return NextResponse.json({ conversations: sortConversations(result), people });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { title?: string; profile_ids?: string[]; agent_slugs?: AgentSlug[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileIds = [...new Set([user.id, ...(body.profile_ids ?? [])])];
  const agentSlugs = [...new Set(body.agent_slugs ?? [])].filter((slug): slug is AgentSlug => slug === "aria" || slug === "marco");
  if (profileIds.length + agentSlugs.length < 2) {
    return NextResponse.json({ error: "Choose at least one other person or agent" }, { status: 400 });
  }

  const [{ data: validProfiles }, { data: validAgents }] = await Promise.all([
    supabase.from("profiles").select("id").in("id", profileIds),
    agentSlugs.length
      ? supabase.from("conversation_agents").select("id,slug").in("slug", agentSlugs).eq("active", true)
      : Promise.resolve({ data: [] as { id: string; slug: string }[] }),
  ]);
  if ((validProfiles ?? []).length !== profileIds.length || (validAgents ?? []).length !== agentSlugs.length) {
    return NextResponse.json({ error: "One or more participants are unavailable" }, { status: 400 });
  }

  const kind = profileIds.length + agentSlugs.length === 2 ? "direct" : "group";
  if (kind === "direct") {
    const { data: ownMemberships } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("profile_id", user.id);
    const candidateIds = (ownMemberships ?? []).map((membership) => membership.conversation_id);
    if (candidateIds.length > 0) {
      const { data: candidates } = await supabase
        .from("conversations")
        .select("id")
        .in("id", candidateIds)
        .eq("kind", "direct")
        .is("archived_at", null);
      const directIds = (candidates ?? []).map((candidate) => candidate.id);
      if (directIds.length > 0) {
        const { data: candidateParticipants } = await supabase
          .from("conversation_participants")
          .select("conversation_id,profile_id,agent_id")
          .in("conversation_id", directIds);
        const expected = new Set([
          ...profileIds.map((profileId) => `human:${profileId}`),
          ...(validAgents ?? []).map((agent) => `agent:${agent.id}`),
        ]);
        for (const candidateId of directIds) {
          const keys = (candidateParticipants ?? [])
            .filter((participant) => participant.conversation_id === candidateId)
            .map((participant) => participant.profile_id ? `human:${participant.profile_id}` : `agent:${participant.agent_id}`);
          if (keys.length === expected.size && keys.every((key) => expected.has(key))) {
            return NextResponse.json({ id: candidateId, existing: true });
          }
        }
      }
    }
  }

  const { data: conversation, error } = await supabase
    .from("conversations")
    .insert({ kind, title: body.title?.trim() || null, created_by: user.id })
    .select("id")
    .single();
  if (error || !conversation) return NextResponse.json({ error: error?.message ?? "Could not create conversation" }, { status: 500 });

  const participantRows = [
    ...profileIds.map((profileId) => ({ conversation_id: conversation.id, profile_id: profileId, agent_id: null })),
    ...(validAgents ?? []).map((agent) => ({ conversation_id: conversation.id, profile_id: null, agent_id: agent.id })),
  ];
  const { error: participantError } = await supabase.from("conversation_participants").insert(participantRows);
  if (participantError) {
    await supabase.from("conversations").delete().eq("id", conversation.id);
    return NextResponse.json({ error: participantError.message }, { status: 500 });
  }

  return NextResponse.json({ id: conversation.id }, { status: 201 });
}
