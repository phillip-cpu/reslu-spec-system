import { NextRequest, NextResponse } from "next/server";
import { buildRealtimeVoiceLatencyMetadata } from "@/lib/realtime-voice-metrics";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
type Presentation = "office" | "driving" | "meeting";

const PRESENTATIONS = new Set<Presentation>(["office", "driving", "meeting"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function callErrorStatus(message: string) {
  if (/conversation not found|call not found/i.test(message)) return 404;
  if (/already used|current state/i.test(message)) return 409;
  if (/required|invalid|too long|unauthorized/i.test(message)) return 400;
  return 500;
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let rawBody: unknown = {};
  try { rawBody = await request.json(); } catch { /* an empty body uses compatible defaults */ }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as { presentation?: unknown; client_call_id?: unknown };
  if (body.presentation != null && (typeof body.presentation !== "string" || !PRESENTATIONS.has(body.presentation as Presentation))) {
    return NextResponse.json({ error: "Invalid call presentation" }, { status: 400 });
  }
  if (body.client_call_id != null && (typeof body.client_call_id !== "string" || !UUID_PATTERN.test(body.client_call_id))) {
    return NextResponse.json({ error: "Invalid client call id" }, { status: 400 });
  }
  const presentation = (body.presentation ?? "office") as Presentation;
  // Older cached clients may omit the value during migration rollout. New
  // clients always generate and retain it before the request so a lost HTTP
  // response can recover the same canonical call instead of duplicating it.
  const clientCallId = typeof body.client_call_id === "string" ? body.client_call_id : crypto.randomUUID();
  const { data, error } = await supabase.rpc("create_conversation_call_idempotent", {
    p_conversation_id: id,
    p_presentation: presentation,
    p_client_call_id: clientCallId,
  }).single();
  if (error || !data) {
    const message = error?.message ?? "Could not start call";
    return NextResponse.json({ error: message }, { status: callErrorStatus(message) });
  }
  return NextResponse.json({ call: data }, { status: 201 });
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try { rawBody = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as { call_id?: unknown; summary?: unknown; voice_metrics?: unknown };
  if (typeof body.call_id !== "string" || !UUID_PATTERN.test(body.call_id)) {
    return NextResponse.json({ error: "Valid call_id is required" }, { status: 400 });
  }
  if (body.summary != null && typeof body.summary !== "string") {
    return NextResponse.json({ error: "Invalid call summary" }, { status: 400 });
  }
  const summary = typeof body.summary === "string" ? body.summary.trim() : null;
  if (summary && summary.length > 2000) {
    return NextResponse.json({ error: "Call summary is too long" }, { status: 400 });
  }
  const voiceLatency = buildRealtimeVoiceLatencyMetadata(body.voice_metrics);
  const { data, error } = await supabase.rpc("end_conversation_call_idempotent", {
    p_conversation_id: id,
    p_call_id: body.call_id,
    p_summary: summary || null,
    p_voice_latency: voiceLatency,
  }).single();
  if (error || !data) {
    const message = error?.message ?? "Could not end call";
    return NextResponse.json({ error: message }, { status: callErrorStatus(message) });
  }
  return NextResponse.json({ call: data });
}
