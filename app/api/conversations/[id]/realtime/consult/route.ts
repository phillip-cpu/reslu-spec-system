import { NextRequest, NextResponse } from "next/server";
import { authorizedConversationAgent, conversationParticipants } from "@/lib/conversation-access";
import { consultStatus, parseRealtimeConsultRequest } from "@/lib/realtime-consult";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function authorizedRequest(id: string, requestedSlug?: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const participantResult = await conversationParticipants(supabase, id, user.id);
  const agent = authorizedConversationAgent(participantResult.participants, user.id, requestedSlug ?? null);
  if (participantResult.error || !agent?.agent_slug) {
    return { error: NextResponse.json({ error: "Conversation or agent not found" }, { status: 404 }) } as const;
  }
  return { supabase, user, agent, error: null } as const;
}

async function messageForToolCall(supabase: Awaited<ReturnType<typeof createClient>>, id: string, toolCallId: string) {
  return supabase
    .from("conversation_messages")
    .select("id,body,metadata")
    .eq("conversation_id", id)
    .contains("metadata", { realtime_tool_call_id: toolCallId })
    .maybeSingle();
}

async function resultForMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  messageId: string,
  agentId: string
) {
  const { data: job, error: jobError } = await supabase
    .from("agent_conversation_jobs")
    .select("id,status,error,claimed_at,completed_at")
    .eq("conversation_id", id)
    .eq("triggering_message_id", messageId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (jobError) throw new Error(jobError.message);
  if (!job) return { status: "pending" as const, job: null, reply: null };
  const { data: reply, error: replyError } = await supabase
    .from("conversation_messages")
    .select("id,body,metadata,created_at")
    .eq("conversation_id", id)
    .contains("metadata", { job_id: job.id })
    .maybeSingle();
  if (replyError) throw new Error(replyError.message);
  return { status: consultStatus(job.status, Boolean(reply)), job, reply };
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const body = parseRealtimeConsultRequest(raw);
  if (!body) return NextResponse.json({ error: "Invalid realtime consult request" }, { status: 400 });

  const access = await authorizedRequest(id, body.agentSlug);
  if (access.error) return access.error;
  const { supabase, user, agent } = access;

  const existing = await messageForToolCall(supabase, id, body.toolCallId);
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
  if (existing.data) {
    const result = await resultForMessage(supabase, id, existing.data.id, agent.id);
    return NextResponse.json({
      consult_id: existing.data.id,
      status: result.status,
      job_id: result.job?.id ?? null,
    }, { status: result.status === "done" ? 200 : 202 });
  }

  // A newer voice consult supersedes unfinished speech for this agent. This
  // suppresses late output but cannot reverse a business action already done.
  await supabase.rpc("cancel_agent_conversation_jobs", {
    p_conversation_id: id,
    p_agent_ids: [agent.id],
  });

  const metadata = {
    source: "voice",
    transport: "openai_realtime_webrtc",
    realtime_call_id: body.callId,
    realtime_tool_call_id: body.toolCallId,
    realtime_response_id: body.responseId,
    target_agent_slugs: [agent.agent_slug],
  };
  let { data: message, error: messageError } = await supabase
    .from("conversation_messages")
    .insert({
      conversation_id: id,
      author_profile_id: user.id,
      body: body.query,
      metadata,
    })
    .select("id,body,metadata")
    .single();

  // The database unique index makes a repeated provider event idempotent.
  if (messageError?.code === "23505") {
    const duplicate = await messageForToolCall(supabase, id, body.toolCallId);
    message = duplicate.data;
    messageError = duplicate.error;
  }
  if (messageError || !message) {
    return NextResponse.json({ error: messageError?.message ?? "Could not save voice turn" }, { status: 500 });
  }

  // Migration 090 normally creates this in the message transaction. Retain
  // the compatibility upsert used by text chat while environments roll out.
  const { data: job, error: jobError } = await supabase
    .from("agent_conversation_jobs")
    .upsert({
      conversation_id: id,
      triggering_message_id: message.id,
      agent_id: agent.id,
    }, { onConflict: "triggering_message_id,agent_id", ignoreDuplicates: true })
    .select("id,status")
    .maybeSingle();
  if (jobError) {
    console.error("Realtime voice turn saved but consult enqueue failed", {
      conversationId: id,
      messageId: message.id,
      agentSlug: agent.agent_slug,
      error: jobError.message,
    });
  }
  return NextResponse.json({
    consult_id: message.id,
    job_id: job?.id ?? null,
    status: "pending",
    queue_error: jobError?.message ?? null,
  }, { status: 202 });
}

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const toolCallId = request.nextUrl.searchParams.get("tool_call_id")?.trim();
  const requestedSlug = request.nextUrl.searchParams.get("agent_slug")?.trim().toLowerCase();
  if (!toolCallId || !/^[A-Za-z0-9_-]{1,160}$/.test(toolCallId)) {
    return NextResponse.json({ error: "tool_call_id is required" }, { status: 400 });
  }
  const access = await authorizedRequest(id, requestedSlug);
  if (access.error) return access.error;
  const message = await messageForToolCall(access.supabase, id, toolCallId);
  if (message.error) return NextResponse.json({ error: message.error.message }, { status: 500 });
  if (!message.data) return NextResponse.json({ error: "Consult not found" }, { status: 404 });
  try {
    const result = await resultForMessage(access.supabase, id, message.data.id, access.agent.id);
    return NextResponse.json({
      consult_id: message.data.id,
      status: result.status,
      answer: result.status === "done" ? result.reply?.body : null,
      error: result.status === "failed" ? result.job?.error ?? "Agent consult failed" : null,
      side_effects_may_have_completed: result.status === "cancelled",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read consult" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let body: { tool_call_id?: string; agent_slug?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const toolCallId = body.tool_call_id?.trim();
  if (!toolCallId || !/^[A-Za-z0-9_-]{1,160}$/.test(toolCallId)) {
    return NextResponse.json({ error: "tool_call_id is required" }, { status: 400 });
  }
  const access = await authorizedRequest(id, body.agent_slug?.trim().toLowerCase());
  if (access.error) return access.error;
  const { data, error } = await access.supabase.rpc("cancel_realtime_conversation_job", {
    p_conversation_id: id,
    p_tool_call_id: toolCallId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    status: data ? "cancelled" : "already_terminal",
    side_effects_may_have_completed: true,
  });
}
