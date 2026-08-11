import { NextRequest, NextResponse } from "next/server";
import { parseRealtimeAgentTaskRequest, realtimeTaskAcknowledgement, taskIntentMatches } from "@/lib/agent-tasks";
import { authorizedConversationAgent, conversationParticipants } from "@/lib/conversation-access";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const body = parseRealtimeAgentTaskRequest(raw);
  if (!body) return NextResponse.json({ error: "Invalid realtime task request" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const participantResult = await conversationParticipants(supabase, id, user.id);
  const agent = authorizedConversationAgent(participantResult.participants, user.id, body.agentSlug);
  if (participantResult.error || !agent?.agent_slug) {
    return NextResponse.json({ error: "Conversation or agent not found" }, { status: 404 });
  }

  const existingTask = await supabase.from("agent_tasks").select("*")
    .eq("conversation_id", id).eq("client_task_id", body.clientTaskId).maybeSingle();
  if (existingTask.error) return NextResponse.json({ error: existingTask.error.message }, { status: 500 });
  if (existingTask.data) {
    if (!taskIntentMatches(existingTask.data, body, agent.id)) {
      return NextResponse.json({ error: "This realtime tool call id was already used for different work" }, { status: 409 });
    }
    return NextResponse.json({
      task: existingTask.data,
      acknowledgement: realtimeTaskAcknowledgement(existingTask.data.title),
    });
  }

  const call = await supabase.from("conversation_calls").select("id")
    .eq("id", body.sourceCallId).eq("conversation_id", id).maybeSingle();
  if (call.error || !call.data) return NextResponse.json({ error: "Call not found" }, { status: 400 });

  const metadata = {
    source: "voice",
    transport: "openai_realtime_webrtc",
    background_task: true,
    realtime_call_id: body.sourceCallId,
    realtime_tool_call_id: body.clientTaskId,
    realtime_response_id: body.realtimeResponseId,
    target_agent_slugs: [body.agentSlug],
    model_tier: body.modelTier,
  };
  let messageResult = await supabase.from("conversation_messages").insert({
    conversation_id: id,
    author_profile_id: user.id,
    body: body.objective,
    metadata,
  }).select("id").single();
  if (messageResult.error?.code === "23505") {
    messageResult = await supabase.from("conversation_messages").select("id")
      .eq("conversation_id", id)
      .contains("metadata", { realtime_tool_call_id: body.clientTaskId })
      .single();
  }
  if (messageResult.error || !messageResult.data) {
    return NextResponse.json({ error: messageResult.error?.message ?? "Could not save task request" }, { status: 500 });
  }

  const { data: task, error } = await supabase.from("agent_tasks").insert({
    conversation_id: id,
    requested_by: user.id,
    owner_agent_id: agent.id,
    source_message_id: messageResult.data.id,
    source_call_id: body.sourceCallId,
    client_task_id: body.clientTaskId,
    title: body.title,
    objective: body.objective,
    requested_via: "voice",
    model_tier: body.modelTier,
  }).select("*").single();
  if (error || !task) return NextResponse.json({ error: error?.message ?? "Could not start background task" }, { status: 500 });
  return NextResponse.json({
    task,
    acknowledgement: realtimeTaskAcknowledgement(task.title),
  }, { status: 201 });
}
