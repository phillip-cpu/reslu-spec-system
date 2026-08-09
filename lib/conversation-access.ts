import type { AgentSlug, ConversationParticipant } from "@/types/conversations";
import type { createClient } from "@/lib/supabase/server";

interface ConversationParticipantRow {
  profile_id: string | null;
  agent_id: string | null;
  profile: { id: string; full_name: string; avatar_url: string | null } | null;
  agent: { id: string; slug: AgentSlug; display_name: string; role_label: string; avatar_url: string | null } | null;
}

export async function conversationParticipants(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  userId: string
): Promise<{ error: { message: string } | null; participants: ConversationParticipant[] }> {
  const { data, error } = await supabase
    .from("conversation_participants")
    .select("profile_id,agent_id,profile:profiles(id,full_name,avatar_url),agent:conversation_agents(id,slug,display_name,role_label,avatar_url)")
    .eq("conversation_id", conversationId);
  if (error) return { error, participants: [] };
  const participants: ConversationParticipant[] = [];
  for (const raw of data ?? []) {
    const row = raw as unknown as ConversationParticipantRow;
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

export function authorizedConversationAgent(
  participants: ConversationParticipant[],
  userId: string,
  requestedSlug: string | null
) {
  const self = participants.find((participant) => participant.type === "human" && participant.id === userId);
  if (!self) return null;
  const agents = participants.filter((participant) => participant.type === "agent");
  if (requestedSlug) return agents.find((participant) => participant.agent_slug === requestedSlug) ?? null;
  return agents.length === 1 ? agents[0] : null;
}
