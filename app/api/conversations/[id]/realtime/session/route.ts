import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants, authorizedConversationAgent } from "@/lib/conversation-access";
import {
  buildRealtimeSession,
  createRealtimeWebRtcCall,
  realtimeConfig,
  realtimeSafetyIdentifier,
} from "@/lib/realtime-voice";
import { createClient } from "@/lib/supabase/server";
import type { AgentSlug } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = request.headers.get("content-type")?.split(";")[0];
  if (contentType !== "application/sdp") {
    return NextResponse.json({ error: "Expected an application/sdp offer" }, { status: 415 });
  }
  const sdp = await request.text();
  if (!sdp.startsWith("v=0") || sdp.length > 100_000) {
    return NextResponse.json({ error: "Invalid WebRTC offer" }, { status: 400 });
  }

  const participantResult = await conversationParticipants(supabase, id, user.id);
  const requestedSlug = request.headers.get("x-reslu-agent")?.toLowerCase() ?? null;
  const agent = authorizedConversationAgent(participantResult.participants, user.id, requestedSlug);
  if (participantResult.error || !agent?.agent_slug) {
    return NextResponse.json({ error: "Conversation or agent not found" }, { status: 404 });
  }

  const config = realtimeConfig(process.env, agent.agent_slug as AgentSlug);
  if (!config.enabled) {
    return NextResponse.json({
      error: "Realtime voice is not enabled for RESLU yet.",
      code: "realtime_disabled",
    }, { status: 503 });
  }
  if (!config.apiKey) {
    return NextResponse.json({
      error: "Realtime voice is enabled but OPENAI_API_KEY is not configured on the server.",
      code: "realtime_not_configured",
    }, { status: 503 });
  }

  try {
    const provider = await createRealtimeWebRtcCall({
      sdp,
      session: buildRealtimeSession({ slug: agent.agent_slug as AgentSlug, display_name: agent.display_name }, config),
      apiKey: config.apiKey,
      safetyIdentifier: realtimeSafetyIdentifier(user.id),
    });
    if (!provider.ok) {
      console.error("OpenAI Realtime session creation failed", {
        conversationId: id,
        agentSlug: agent.agent_slug,
        providerStatus: provider.status,
      });
      return NextResponse.json({
        error: "The realtime voice provider could not start this call. Please try again.",
        code: "realtime_provider_error",
      }, { status: 502 });
    }
    return new NextResponse(provider.body, {
      status: 201,
      headers: { "Content-Type": "application/sdp", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("OpenAI Realtime connection failed", {
      conversationId: id,
      agentSlug: agent.agent_slug,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({
      error: "The realtime voice provider is unavailable. Please try again.",
      code: "realtime_provider_unavailable",
    }, { status: 502 });
  }
}
