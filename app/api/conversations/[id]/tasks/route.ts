import { NextRequest, NextResponse } from "next/server";
import { parseStartAgentTaskRequest, taskIntentMatches } from "@/lib/agent-tasks";
import { authorizedConversationAgent, conversationParticipants } from "@/lib/conversation-access";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function accessConversation(conversationId: string, requestedSlug?: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const participants = await conversationParticipants(supabase, conversationId, user.id);
  const self = participants.participants.find((participant) => participant.type === "human" && participant.id === user.id);
  const agent = requestedSlug
    ? authorizedConversationAgent(participants.participants, user.id, requestedSlug)
    : participants.participants.find((participant) => participant.type === "agent") ?? null;
  if (participants.error || !self || (requestedSlug && !agent?.agent_slug)) {
    return { error: NextResponse.json({ error: "Conversation or agent not found" }, { status: 404 }) } as const;
  }
  return { supabase, user, agent, error: null } as const;
}

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const access = await accessConversation(id);
  if (access.error) return access.error;
  const { data: tasks, error } = await access.supabase
    .from("agent_tasks")
    .select("*,owner_agent:conversation_agents!owner_agent_id(id,slug,display_name,role_label,avatar_url)")
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const taskIds = (tasks ?? []).map((task) => task.id);
  if (taskIds.length === 0) return NextResponse.json({ tasks: [] });
  const [eventsResult, artifactsResult] = await Promise.all([
    access.supabase.from("agent_task_events").select("*").in("task_id", taskIds).order("created_at"),
    access.supabase.from("agent_task_artifacts").select("*").in("task_id", taskIds).order("created_at"),
  ]);
  if (eventsResult.error || artifactsResult.error) {
    return NextResponse.json({ error: eventsResult.error?.message ?? artifactsResult.error?.message }, { status: 500 });
  }
  return NextResponse.json({
    tasks: (tasks ?? []).map((task) => ({
      ...task,
      events: (eventsResult.data ?? []).filter((event) => event.task_id === task.id),
      artifacts: (artifactsResult.data ?? []).filter((artifact) => artifact.task_id === task.id),
    })),
  });
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const body = parseStartAgentTaskRequest(raw);
  if (!body) return NextResponse.json({ error: "Invalid background task request" }, { status: 400 });
  const access = await accessConversation(id, body.agentSlug);
  if (access.error) return access.error;
  if (!access.agent) return NextResponse.json({ error: "Conversation agent not found" }, { status: 404 });

  const existing = await access.supabase
    .from("agent_tasks")
    .select("*")
    .eq("conversation_id", id)
    .eq("client_task_id", body.clientTaskId)
    .maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
  if (existing.data) {
    if (!taskIntentMatches(existing.data, body, access.agent.id)) {
      return NextResponse.json({ error: "This task id was already used for different work" }, { status: 409 });
    }
    return NextResponse.json({ task: existing.data });
  }

  if (body.sourceCallId) {
    const call = await access.supabase.from("conversation_calls").select("id").eq("id", body.sourceCallId).eq("conversation_id", id).maybeSingle();
    if (call.error || !call.data) return NextResponse.json({ error: "Call not found" }, { status: 400 });
  }

  const { data, error } = await access.supabase.from("agent_tasks").insert({
    conversation_id: id,
    requested_by: access.user.id,
    owner_agent_id: access.agent.id,
    source_message_id: body.sourceMessageId,
    source_call_id: body.sourceCallId,
    client_task_id: body.clientTaskId,
    title: body.title,
    objective: body.objective,
    requested_via: body.requestedVia,
    model_tier: body.modelTier,
  }).select("*").single();
  if (error || !data) {
    if (error?.code === "23505") {
      const duplicate = await access.supabase.from("agent_tasks").select("*").eq("conversation_id", id).eq("client_task_id", body.clientTaskId).single();
      if (!duplicate.error && duplicate.data && taskIntentMatches(duplicate.data, body, access.agent.id)) {
        return NextResponse.json({ task: duplicate.data });
      }
    }
    return NextResponse.json({ error: error?.message ?? "Could not create background task" }, { status: 500 });
  }
  return NextResponse.json({ task: data }, { status: 201 });
}
