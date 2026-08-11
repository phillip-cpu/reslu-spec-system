import { NextRequest, NextResponse } from "next/server";
import { meetingModeContext, requireMeetingModeAccess } from "@/lib/meeting-mode-server";
import { createClient } from "@/lib/supabase/server";
import type { MeetingDestinationKind, MeetingType } from "@/types/meeting-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEETING_TYPES = new Set<MeetingType>(["new_lead", "design_meeting", "client_meeting", "site_meeting", "other"]);

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireMeetingModeAccess(supabase, id, user.id);
  if (access.error) return NextResponse.json({ error: access.error }, { status: 404 });
  const { data, error } = await supabase
    .from("conversation_meeting_minutes")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ meetings: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireMeetingModeAccess(supabase, id, user.id);
  if (access.error) return NextResponse.json({ error: access.error }, { status: 404 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.consent_confirmed !== true || typeof body.client_session_id !== "string" || !UUID_PATTERN.test(body.client_session_id)) {
    return NextResponse.json({ error: "Confirmed participant consent and a valid session id are required" }, { status: 400 });
  }

  const { data: active, error: activeError } = await supabase
    .from("conversation_meeting_minutes")
    .select("*")
    .eq("conversation_id", id)
    .in("status", ["recording", "paused", "processing", "review", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) return NextResponse.json({ error: activeError.message }, { status: 500 });
  if (active) return NextResponse.json({ meeting: active }, { status: 200 });

  const destinationKind = body.destination_kind === "lead" || body.destination_kind === "project"
    ? body.destination_kind as MeetingDestinationKind
    : null;
  const destinationId = typeof body.destination_id === "string" && UUID_PATTERN.test(body.destination_id) ? body.destination_id : null;
  if ((destinationKind && !destinationId) || (!destinationKind && destinationId)) {
    return NextResponse.json({ error: "Choose a complete meeting destination or leave it unassigned" }, { status: 400 });
  }
  const requestedClientEventId = body.client_event_id == null
    ? null
    : typeof body.client_event_id === "string" && UUID_PATTERN.test(body.client_event_id)
      ? body.client_event_id
      : undefined;
  if (requestedClientEventId === undefined || (destinationKind !== "project" && requestedClientEventId !== null)) {
    return NextResponse.json({ error: "Choose a valid calendar event for this project" }, { status: 400 });
  }

  let selected = null;
  try {
    const resolved = await meetingModeContext(supabase, id);
    selected = destinationKind && destinationId
      ? resolved.candidates.find((candidate) => (
          candidate.kind === destinationKind
          && candidate.id === destinationId
          && candidate.client_event_id === requestedClientEventId
        )) ?? null
      : null;
    if (destinationKind && !selected) return NextResponse.json({ error: "The selected lead, project or calendar event is no longer available" }, { status: 409 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not validate the meeting destination" }, { status: 500 });
  }

  const meetingType = typeof body.meeting_type === "string" && MEETING_TYPES.has(body.meeting_type as MeetingType)
    ? body.meeting_type as MeetingType
    : selected?.meeting_type ?? "client_meeting";
  let sourceCallId: string | null = null;
  if (typeof body.source_call_id === "string" && UUID_PATTERN.test(body.source_call_id)) {
    const call = await supabase
      .from("conversation_calls")
      .select("id")
      .eq("id", body.source_call_id)
      .eq("conversation_id", id)
      .maybeSingle();
    if (call.error || !call.data) return NextResponse.json({ error: "Call not found" }, { status: 400 });
    sourceCallId = call.data.id;
  }
  const values = {
    conversation_id: id,
    source_call_id: sourceCallId,
    created_by: user.id,
    client_session_id: body.client_session_id,
    status: "recording",
    meeting_type: meetingType,
    lead_id: selected?.kind === "lead" ? selected.id : null,
    project_id: selected?.kind === "project" ? selected.id : null,
    client_event_id: selected?.kind === "project" ? selected.client_event_id : null,
    destination_kind: selected?.kind ?? null,
    destination_label_snapshot: selected?.label ?? null,
    destination_confidence: selected?.confidence ?? null,
    destination_reasons: selected?.reasons ?? [],
    source_snapshot: selected ? {
      kind: selected.kind,
      id: selected.id,
      label: selected.label,
      client_event_id: selected.client_event_id,
      source_reference: selected.source_reference,
      confidence: selected.confidence,
      reasons: selected.reasons,
      resolved_at: new Date().toISOString(),
    } : { resolved_at: new Date().toISOString(), unassigned: true },
    consent_confirmed_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("conversation_meeting_minutes")
    .upsert(values, { onConflict: "conversation_id,client_session_id", ignoreDuplicates: false })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ meeting: data }, { status: 201 });
}
