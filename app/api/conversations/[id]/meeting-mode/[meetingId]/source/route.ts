import { NextRequest, NextResponse } from "next/server";
import { requireMeetingModeAccess } from "@/lib/meeting-mode-server";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import type { ConversationMeetingMinutes } from "@/types/meeting-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; meetingId: string }> };

async function authenticatedSource(context: Context) {
  const { id, meetingId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const access = await requireMeetingModeAccess(supabase, id, user.id);
  if (access.error) return { response: NextResponse.json({ error: access.error }, { status: 404 }) };
  const { data, error } = await supabase
    .from("conversation_meeting_minutes")
    .select("*")
    .eq("id", meetingId)
    .eq("conversation_id", id)
    .maybeSingle();
  if (error) return { response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!data) return { response: NextResponse.json({ error: "Meeting not found" }, { status: 404 }) };
  return { user, meeting: data as ConversationMeetingMinutes, conversationId: id };
}

function exportFilename(meeting: ConversationMeetingMinutes, extension: string) {
  const label = (meeting.destination_label_snapshot || "meeting-minutes")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "meeting-minutes";
  return `${label}-${meeting.started_at.slice(0, 10)}.${extension}`;
}

async function auditSourceEvent(
  meetingId: string,
  actorId: string,
  eventType: "source_exported" | "source_deleted" | "retention_purged",
  kinds: string[],
) {
  const service = createServiceRoleClient();
  const { error } = await service.from("conversation_meeting_minute_events").insert({
    minutes_id: meetingId,
    actor_id: actorId,
    event_type: eventType,
    metadata: { kinds },
  });
  if (error) throw new Error(`Meeting source audit failed: ${error.message}`);
}

export async function GET(request: NextRequest, context: Context) {
  const result = await authenticatedSource(context);
  if ("response" in result) return result.response;
  const kind = request.nextUrl.searchParams.get("kind") ?? "transcript";

  if (kind === "recording") {
    if (result.meeting.created_by !== result.user.id) {
      return NextResponse.json({ error: "Only the recorder can export the raw meeting audio" }, { status: 403 });
    }
    if (!result.meeting.recording_storage_path || result.meeting.recording_deleted_at) {
      return NextResponse.json({ error: "The source recording is no longer retained" }, { status: 404 });
    }
    const service = createServiceRoleClient();
    const { data, error } = await service.storage.from(ASSET_BUCKET).createSignedUrl(
      result.meeting.recording_storage_path,
      60,
      { download: result.meeting.recording_filename ?? exportFilename(result.meeting, "m4a") },
    );
    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: error?.message ?? "Could not export the recording" }, { status: 500 });
    }
    await auditSourceEvent(result.meeting.id, result.user.id, "source_exported", ["recording"]);
    return NextResponse.redirect(data.signedUrl, 303);
  }

  if (!result.meeting.transcript || result.meeting.transcript_deleted_at) {
    return NextResponse.json({ error: "The source transcript is no longer retained" }, { status: 404 });
  }

  const commonHeaders = {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Disposition": `attachment; filename="${exportFilename(result.meeting, kind === "bundle" ? "json" : "txt")}"`,
    "X-Content-Type-Options": "nosniff",
  };
  if (kind === "transcript") {
    await auditSourceEvent(result.meeting.id, result.user.id, "source_exported", ["transcript"]);
    return new NextResponse(result.meeting.transcript, {
      headers: { ...commonHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (kind !== "bundle") {
    return NextResponse.json({ error: "Choose transcript, recording or bundle" }, { status: 400 });
  }

  const bundle = {
    exported_at: new Date().toISOString(),
    meeting: {
      id: result.meeting.id,
      conversation_id: result.meeting.conversation_id,
      meeting_type: result.meeting.meeting_type,
      destination_kind: result.meeting.destination_kind,
      destination_label: result.meeting.destination_label_snapshot,
      started_at: result.meeting.started_at,
      ended_at: result.meeting.ended_at,
      duration_seconds: result.meeting.duration_seconds,
      status: result.meeting.status,
      summary: result.meeting.summary,
      decisions: result.meeting.decisions,
      client_requests: result.meeting.client_requests,
      reslu_actions: result.meeting.reslu_actions,
      client_actions: result.meeting.client_actions,
      open_questions: result.meeting.open_questions,
      important_notes: result.meeting.important_notes,
      transcript: result.meeting.transcript,
      transcript_segments: result.meeting.transcript_segments,
      recording_retain_until: result.meeting.recording_retain_until,
      transcript_retain_until: result.meeting.transcript_retain_until,
    },
  };
  await auditSourceEvent(result.meeting.id, result.user.id, "source_exported", ["minutes", "transcript"]);
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: { ...commonHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  const result = await authenticatedSource(context);
  if ("response" in result) return result.response;
  if (result.meeting.created_by !== result.user.id) {
    return NextResponse.json({ error: "Only the recorder can delete meeting source material" }, { status: 403 });
  }
  if (!["review", "filed", "discarded", "failed"].includes(result.meeting.status)) {
    return NextResponse.json({ error: "Finish processing the meeting before deleting its source" }, { status: 409 });
  }
  const body = await request.json().catch(() => null) as { recording?: boolean; transcript?: boolean } | null;
  const deleteRecording = body?.recording === true;
  const deleteTranscript = body?.transcript === true;
  if (!deleteRecording && !deleteTranscript) {
    return NextResponse.json({ error: "Choose a recording or transcript to delete" }, { status: 400 });
  }

  const service = createServiceRoleClient();
  if (deleteRecording && result.meeting.recording_storage_path) {
    const { error } = await service.storage.from(ASSET_BUCKET).remove([result.meeting.recording_storage_path]);
    if (error) return NextResponse.json({ error: `The private recording could not be deleted: ${error.message}` }, { status: 500 });
  }

  const now = new Date().toISOString();
  const values: Record<string, unknown> = {};
  const kinds: string[] = [];
  if (deleteRecording) {
    Object.assign(values, {
      recording_storage_path: null,
      recording_filename: null,
      recording_mime_type: null,
      recording_byte_size: null,
      recording_deleted_at: result.meeting.recording_deleted_at ?? now,
      recording_deleted_by: result.meeting.recording_deleted_by ?? result.user.id,
    });
    kinds.push("recording");
  }
  if (deleteTranscript) {
    Object.assign(values, {
      transcript: null,
      transcript_segments: [],
      transcript_deleted_at: result.meeting.transcript_deleted_at ?? now,
      transcript_deleted_by: result.meeting.transcript_deleted_by ?? result.user.id,
    });
    kinds.push("transcript");
  }
  const { data, error } = await service
    .from("conversation_meeting_minutes")
    .update(values)
    .eq("id", result.meeting.id)
    .eq("conversation_id", result.conversationId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await auditSourceEvent(result.meeting.id, result.user.id, "source_deleted", kinds);
  return NextResponse.json({ meeting: data }, { headers: { "Cache-Control": "no-store" } });
}
