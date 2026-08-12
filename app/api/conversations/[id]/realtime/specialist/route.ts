import { NextRequest, NextResponse } from "next/server";
import { authorizedConversationAgent, conversationParticipants } from "@/lib/conversation-access";
import { consultStatus } from "@/lib/realtime-consult";
import {
  otherResluAgent,
  parseRealtimeSpecialistConsultRequest,
} from "@/lib/realtime-specialist-consult";
import { millisecondsBetween } from "@/lib/realtime-voice-metrics";
import { createClient } from "@/lib/supabase/server";
import type { AgentSlug } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function authorizedOwner(id: string, requestedSlug?: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const membership = await conversationParticipants(supabase, id, user.id);
  const owner = authorizedConversationAgent(membership.participants, user.id, requestedSlug ?? null);
  if (membership.error || !owner?.agent_slug) {
    return { error: NextResponse.json({ error: "Conversation or owner agent not found" }, { status: 404 }) } as const;
  }
  return { supabase, user, owner, error: null } as const;
}

async function consultationForToolCall(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  ownerAgentId: string,
  toolCallId: string,
) {
  return supabase
    .from("conversation_agent_consultations")
    .select("id,status,triggering_message_id,specialist_job_id,response_message_id,specialist_agent_id,created_at,claimed_at,completed_at")
    .eq("conversation_id", conversationId)
    .eq("owner_agent_id", ownerAgentId)
    .eq("realtime_tool_call_id", toolCallId)
    .maybeSingle();
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = parseRealtimeSpecialistConsultRequest(raw);
  if (!body) return NextResponse.json({ error: "Invalid specialist consultation request" }, { status: 400 });

  const access = await authorizedOwner(id, body.ownerAgentSlug);
  if (access.error) return access.error;
  const specialistSlug = otherResluAgent(body.ownerAgentSlug);
  const { data, error } = await access.supabase.rpc("start_conversation_agent_consultation", {
    p_conversation_id: id,
    p_owner_agent_slug: body.ownerAgentSlug,
    p_specialist_agent_slug: specialistSlug,
    p_source_call_id: body.callId,
    p_tool_call_id: body.toolCallId,
    p_response_id: body.responseId,
    p_query: body.query,
  });
  if (error) {
    const conflict = /idempotency key conflict/i.test(error.message);
    const inactiveCall = /active voice call not found/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: conflict || inactiveCall ? 409 : 500 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return NextResponse.json({ error: "The specialist consultation could not be queued" }, { status: 503 });
  return NextResponse.json({
    consultation_id: row.consultation_id,
    consult_id: row.message_id,
    job_id: row.job_id,
    status: row.consultation_status,
    owner_agent: body.ownerAgentSlug,
    consulted_agent: specialistSlug,
  }, { status: row.consultation_status === "done" ? 200 : 202 });
}

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const toolCallId = request.nextUrl.searchParams.get("tool_call_id")?.trim();
  const ownerSlug = request.nextUrl.searchParams.get("owner_agent_slug")?.trim().toLowerCase();
  if (!toolCallId || !/^[A-Za-z0-9_-]{1,160}$/.test(toolCallId)) {
    return NextResponse.json({ error: "tool_call_id is required" }, { status: 400 });
  }
  const access = await authorizedOwner(id, ownerSlug);
  if (access.error) return access.error;
  const consultation = await consultationForToolCall(access.supabase, id, access.owner.id, toolCallId);
  if (consultation.error) return NextResponse.json({ error: consultation.error.message }, { status: 500 });
  if (!consultation.data) return NextResponse.json({ error: "Specialist consultation not found" }, { status: 404 });

  const [{ data: job, error: jobError }, { data: specialist, error: specialistError }] = await Promise.all([
    access.supabase
      .from("agent_conversation_jobs")
      .select("id,status,error,created_at,claimed_at,completed_at")
      .eq("id", consultation.data.specialist_job_id)
      .maybeSingle(),
    access.supabase
      .from("conversation_agents")
      .select("slug,display_name")
      .eq("id", consultation.data.specialist_agent_id)
      .maybeSingle(),
  ]);
  if (jobError || specialistError) {
    return NextResponse.json({ error: jobError?.message ?? specialistError?.message ?? "Could not read specialist status" }, { status: 500 });
  }
  let reply: { body: string; created_at: string } | null = null;
  if (consultation.data.response_message_id) {
    const result = await access.supabase
      .from("conversation_messages")
      .select("body,created_at")
      .eq("id", consultation.data.response_message_id)
      .maybeSingle();
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
    reply = result.data;
  }
  const status = consultStatus(job?.status ?? consultation.data.status, Boolean(reply));
  const resolvedOwnerSlug = access.owner.agent_slug as AgentSlug;
  return NextResponse.json({
    consultation_id: consultation.data.id,
    status,
    answer: status === "done" ? reply?.body ?? null : null,
    error: status === "failed" ? job?.error ?? "Specialist consultation failed" : null,
    owner_agent: resolvedOwnerSlug,
    consulted_agent: specialist?.slug ?? otherResluAgent(resolvedOwnerSlug),
    side_effects_may_have_completed: status === "cancelled",
    latency: {
      queue_wait_ms: millisecondsBetween(job?.created_at, job?.claimed_at),
      agent_processing_ms: millisecondsBetween(job?.claimed_at, job?.completed_at),
      backend_total_ms: millisecondsBetween(consultation.data.created_at, reply?.created_at ?? job?.completed_at),
    },
  });
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let body: { tool_call_id?: string; owner_agent_slug?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const toolCallId = body.tool_call_id?.trim();
  if (!toolCallId || !/^[A-Za-z0-9_-]{1,160}$/.test(toolCallId)) {
    return NextResponse.json({ error: "tool_call_id is required" }, { status: 400 });
  }
  const access = await authorizedOwner(id, body.owner_agent_slug?.trim().toLowerCase());
  if (access.error) return access.error;
  const consultation = await consultationForToolCall(access.supabase, id, access.owner.id, toolCallId);
  if (consultation.error) return NextResponse.json({ error: consultation.error.message }, { status: 500 });
  if (!consultation.data) return NextResponse.json({ error: "Specialist consultation not found" }, { status: 404 });
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
