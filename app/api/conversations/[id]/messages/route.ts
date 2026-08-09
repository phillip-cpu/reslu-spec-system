import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { messageAuthor } from "@/lib/conversations";
import type { AgentSlug, ConversationMessage, ConversationParticipant } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function conversationParticipants(supabase: Awaited<ReturnType<typeof createClient>>, conversationId: string, userId: string) {
  const { data, error } = await supabase
    .from("conversation_participants")
    .select("profile_id,agent_id,profile:profiles(id,full_name,avatar_url),agent:conversation_agents(id,slug,display_name,role_label,avatar_url)")
    .eq("conversation_id", conversationId);
  if (error) return { error, participants: [] as ConversationParticipant[] };
  const participants: ConversationParticipant[] = [];
  for (const raw of data ?? []) {
    const row = raw as unknown as {
      profile_id: string | null;
      agent_id: string | null;
      profile: { id: string; full_name: string; avatar_url: string | null } | null;
      agent: { id: string; slug: AgentSlug; display_name: string; role_label: string; avatar_url: string | null } | null;
    };
    if (row.profile) participants.push({
      id: row.profile.id,
      type: "human",
      display_name: row.profile.full_name,
      avatar_url: row.profile.avatar_url,
      is_self: row.profile.id === userId,
    });
    if (row.agent) participants.push({
      id: row.agent.id,
      type: "agent",
      display_name: row.agent.display_name,
      avatar_url: row.agent.avatar_url,
      agent_slug: row.agent.slug,
      role_label: row.agent.role_label,
    });
  }
  return { error: null, participants };
}

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
    .select("*")
    .eq("conversation_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = (data ?? []).reverse().map((row) => ({
    ...row,
    metadata: row.metadata ?? {},
    author: messageAuthor(row, participantResult.participants),
  })) as ConversationMessage[];
  return NextResponse.json({ messages, participants: participantResult.participants });
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { body?: string; source?: "text" | "voice"; target_agent_slugs?: AgentSlug[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messageBody = body.body?.trim();
  if (!messageBody) return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 });
  if (messageBody.length > 20000) return NextResponse.json({ error: "Message is too long" }, { status: 400 });

  const participantResult = await conversationParticipants(supabase, id, user.id);
  const self = participantResult.participants.find((participant) => participant.type === "human" && participant.id === user.id);
  if (!self) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const { data: message, error } = await supabase
    .from("conversation_messages")
    .insert({
      conversation_id: id,
      author_profile_id: user.id,
      body: messageBody,
      metadata: { source: body.source === "voice" ? "voice" : "text" },
    })
    .select("*")
    .single();
  if (error || !message) return NextResponse.json({ error: error?.message ?? "Could not send message" }, { status: 500 });

  const agents = participantResult.participants.filter((participant) => participant.type === "agent");
  const explicitTargets = new Set(body.target_agent_slugs ?? []);
  const mentionedTargets = agents.filter((agent) => {
    const slug = agent.agent_slug!;
    return explicitTargets.has(slug) || new RegExp(`(?:^|\\s)@?${agent.display_name}(?:\\s|[,.!?]|$)`, "i").test(messageBody);
  });
  const targetAgents = agents.length === 1 && participantResult.participants.length === 2 && explicitTargets.size === 0
    ? agents
    : mentionedTargets;
  if (targetAgents.length > 0) {
    if (body.source === "voice") {
      // A newer spoken turn supersedes unfinished speech. The Mac bridge
      // checks this state before publishing output, so a late reply cannot
      // appear after the interruption. Any business side effect already
      // completed by the agent remains real and auditable.
      await supabase.rpc("cancel_agent_conversation_jobs", {
        p_conversation_id: id,
        p_agent_ids: targetAgents.map((agent) => agent.id),
      });
    }
    await supabase.from("agent_conversation_jobs").insert(targetAgents.map((agent) => ({
      conversation_id: id,
      triggering_message_id: message.id,
      agent_id: agent.id,
    })));
  }

  return NextResponse.json({
    message: { ...message, metadata: message.metadata ?? {}, author: self },
    queued_agents: targetAgents.map((agent) => agent.agent_slug),
  }, { status: 201 });
}
