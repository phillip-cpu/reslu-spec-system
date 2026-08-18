import { NextRequest, NextResponse } from "next/server";
import {
  MAX_MEETING_AUDIO_BYTES,
  cleanMeetingString,
  cleanMeetingStringList,
  validMeetingRecordingStoragePath,
  validMeetingRecordingMimeType,
} from "@/lib/meeting-mode";
import { inspectStorageObjectHead, sniffFileKind } from "@/lib/file-sniff";
import { requireMeetingModeAccess } from "@/lib/meeting-mode-server";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import type { ConversationMeetingMinutes, MeetingDestinationKind, MeetingType } from "@/types/meeting-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; meetingId: string }> };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEETING_TYPES = new Set<MeetingType>(["new_lead", "design_meeting", "client_meeting", "site_meeting", "other"]);

async function authenticatedMeeting(context: Context) {
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
  return { supabase, user, meeting: data as ConversationMeetingMinutes, conversationId: id };
}

export async function GET(_request: NextRequest, context: Context) {
  const result = await authenticatedMeeting(context);
  if ("response" in result) return result.response;
  return NextResponse.json(
    { meeting: result.meeting, can_manage_source: result.meeting.created_by === result.user.id },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function validatedDestination(
  supabase: Awaited<ReturnType<typeof createClient>>,
  kind: MeetingDestinationKind | null,
  destinationId: string | null,
  clientEventId: string | null,
) {
  if (!kind || !destinationId) return { values: { destination_kind: null, lead_id: null, project_id: null, client_event_id: null, destination_label_snapshot: null } };
  if (kind === "lead") {
    const { data } = await supabase.from("leads").select("id,first_name,surname_project").eq("id", destinationId).is("deleted_at", null).maybeSingle();
    if (!data) return { error: "The selected lead no longer exists" };
    return { values: {
      destination_kind: "lead",
      lead_id: data.id,
      project_id: null,
      client_event_id: null,
      destination_label_snapshot: [data.first_name, data.surname_project].filter(Boolean).join(" ") || "Lead",
    } };
  }
  const { data } = await supabase.from("projects").select("id,name").eq("id", destinationId).is("deleted_at", null).maybeSingle();
  if (!data) return { error: "The selected project no longer exists" };
  if (clientEventId) {
    const { data: event } = await supabase.from("client_events").select("id").eq("id", clientEventId).eq("project_id", destinationId).is("deleted_at", null).maybeSingle();
    if (!event) return { error: "The selected calendar event no longer belongs to this project" };
  }
  return { values: {
    destination_kind: "project",
    lead_id: null,
    project_id: data.id,
    client_event_id: clientEventId,
    destination_label_snapshot: data.name,
  } };
}

async function queueMeetingDraftTask(
  supabase: Awaited<ReturnType<typeof createClient>>,
  meeting: ConversationMeetingMinutes,
  conversationId: string,
  requestedBy: string,
  clientTaskId: string,
) {
  const { data: aria } = await supabase.from("conversation_agents").select("id").eq("slug", "aria").maybeSingle();
  if (!aria) return { error: "Aria is not configured" as const, taskId: null };
  const { data: task, error } = await supabase
    .from("agent_tasks")
    .insert({
      conversation_id: conversationId,
      requested_by: requestedBy,
      owner_agent_id: aria.id,
      source_call_id: meeting.source_call_id,
      client_task_id: clientTaskId,
      title: "Prepare meeting minutes",
      objective: [
        `Prepare the staged Meeting Mode draft for meeting_minutes_id ${meeting.id}.`,
        "Use get_conversation_meeting_source once. The tool transcribes the private recording locally and returns the verbatim transcript without exposing the signed audio URL. Then call complete_conversation_meeting_draft with that exact transcript and a factual structured draft.",
        "Capture summary, decisions, client requests, RESLU actions, client actions, open questions and important notes. Do not infer commitments, send anything, edit a lead/project or file the minutes. The user must review and approve the destination separately.",
      ].join(" "),
      requested_via: "system",
      status: "queued",
      model_tier: "strong",
    })
    .select("id")
    .single();
  return { error: error?.message ?? null, taskId: task?.id ?? null };
}

export async function PATCH(request: NextRequest, context: Context) {
  const result = await authenticatedMeeting(context);
  if ("response" in result) return result.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!body || !action) return NextResponse.json({ error: "A meeting action is required" }, { status: 400 });
  if (["checkpoint", "pause", "resume", "finish", "retry_processing", "discard"].includes(action)
      && result.meeting.created_by !== result.user.id) {
    return NextResponse.json({ error: "Only the recorder can control this meeting capture" }, { status: 403 });
  }

  if (action === "checkpoint") {
    if (!["recording", "paused"].includes(result.meeting.status)) return NextResponse.json({ error: "Meeting capture is not active" }, { status: 409 });
    const duration = Math.max(0, Math.round(Number(body.duration_seconds) || 0));
    const { data, error } = await result.supabase
      .from("conversation_meeting_minutes")
      .update({
        duration_seconds: duration,
        metadata: { ...result.meeting.metadata, last_device_checkpoint_at: new Date().toISOString() },
      })
      .eq("id", result.meeting.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ meeting: data });
  }

  if (action === "pause" || action === "resume") {
    const allowed = action === "pause" ? result.meeting.status === "recording" : result.meeting.status === "paused";
    if (!allowed) return NextResponse.json({ error: `Meeting cannot ${action} from its current state` }, { status: 409 });
    const { data, error } = await result.supabase
      .from("conversation_meeting_minutes")
      .update({ status: action === "pause" ? "paused" : "recording" })
      .eq("id", result.meeting.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ meeting: data });
  }

  if (action === "finish") {
    if (!["recording", "paused"].includes(result.meeting.status)) return NextResponse.json({ error: "Meeting capture is already finished" }, { status: 409 });
    const storagePath = typeof body.recording_storage_path === "string" ? body.recording_storage_path.trim() : "";
    const filename = cleanMeetingString(body.recording_filename, 240);
    const mimeType = cleanMeetingString(body.recording_mime_type, 100);
    const byteSize = Number(body.recording_byte_size);
    const duration = Math.max(1, Math.round(Number(body.duration_seconds) || 0));
    if (!storagePath || !filename || !validMeetingRecordingStoragePath(storagePath, result.conversationId, result.meeting.created_by, result.meeting.id)) {
      return NextResponse.json({ error: "A valid private meeting recording is required" }, { status: 400 });
    }
    if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_MEETING_AUDIO_BYTES) {
      return NextResponse.json({ error: "Meeting audio must be between 1 byte and 250 MB" }, { status: 400 });
    }
    if (!validMeetingRecordingMimeType(mimeType)) {
      return NextResponse.json({ error: "Meeting audio must be an MP4 or WebM recording" }, { status: 400 });
    }
    const inspection = await inspectStorageObjectHead(result.supabase, ASSET_BUCKET, storagePath);
    if (!inspection || inspection.byteSize !== byteSize) {
      return NextResponse.json({ error: "The private meeting upload is incomplete or its size changed. Retry the upload." }, { status: 409 });
    }
    const sniffedKind = sniffFileKind(inspection.bytes);
    const expectedKind = mimeType === "audio/mp4" ? "mp4" : "webm";
    if (sniffedKind !== expectedKind) {
      return NextResponse.json({ error: "The uploaded meeting audio does not match its recording format" }, { status: 400 });
    }

    const { data: updated, error: updateError } = await result.supabase
      .from("conversation_meeting_minutes")
      .update({
        status: "processing",
        ended_at: new Date().toISOString(),
        duration_seconds: duration,
        recording_storage_path: storagePath,
        recording_filename: filename,
        recording_mime_type: mimeType,
        recording_byte_size: byteSize,
        failure_note: null,
      })
      .eq("id", result.meeting.id)
      .eq("status", result.meeting.status)
      .select()
      .maybeSingle();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
    if (!updated) return NextResponse.json({ error: "Meeting capture changed. Refresh before finishing." }, { status: 409 });

    const clientTaskId = `meeting-minutes:${result.meeting.id}`;
    const { data: existingTask } = await result.supabase
      .from("agent_tasks")
      .select("id")
      .eq("conversation_id", result.conversationId)
      .eq("client_task_id", clientTaskId)
      .maybeSingle();
    let taskId = existingTask?.id ?? null;
    if (!taskId) {
      const queued = await queueMeetingDraftTask(result.supabase, updated as ConversationMeetingMinutes, result.conversationId, result.user.id, clientTaskId);
      if (queued.error || !queued.taskId) {
        await result.supabase
          .from("conversation_meeting_minutes")
          .update({ status: "failed", failure_note: queued.error ?? "Aria could not be queued" })
          .eq("id", result.meeting.id)
          .eq("status", "processing");
        return NextResponse.json({ error: "The recording is safe, but Aria could not be queued. Please retry." }, { status: 500 });
      }
      taskId = queued.taskId;
    }
    return NextResponse.json({ meeting: updated, task_id: taskId });
  }

  if (action === "retry_processing") {
    if (result.meeting.status !== "failed" || !result.meeting.recording_storage_path) {
      return NextResponse.json({ error: "This meeting is not ready to retry" }, { status: 409 });
    }
    const { data: retrying, error: transitionError } = await result.supabase
      .from("conversation_meeting_minutes")
      .update({ status: "processing", failure_note: null })
      .eq("id", result.meeting.id)
      .eq("status", "failed")
      .select()
      .maybeSingle();
    if (transitionError) return NextResponse.json({ error: transitionError.message }, { status: 500 });
    if (!retrying) return NextResponse.json({ error: "Meeting processing already resumed" }, { status: 409 });
    const clientTaskId = `meeting-minutes:${result.meeting.id}:retry:${crypto.randomUUID()}`;
    const queued = await queueMeetingDraftTask(result.supabase, retrying as ConversationMeetingMinutes, result.conversationId, result.user.id, clientTaskId);
    if (queued.error || !queued.taskId) {
      await result.supabase
        .from("conversation_meeting_minutes")
        .update({ status: "failed", failure_note: queued.error ?? "Aria could not be queued" })
        .eq("id", result.meeting.id)
        .eq("status", "processing");
      return NextResponse.json({ error: queued.error ?? "Aria could not be queued" }, { status: 500 });
    }
    return NextResponse.json({ meeting: retrying, task_id: queued.taskId });
  }

  if (action === "save_draft") {
    if (result.meeting.status !== "review") return NextResponse.json({ error: "The draft is not ready for editing" }, { status: 409 });
    const expectedVersion = Number(body.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== result.meeting.draft_version) {
      return NextResponse.json({ error: "The draft changed. Refresh it before saving." }, { status: 409 });
    }
    const destinationKind = body.destination_kind === "lead" || body.destination_kind === "project" ? body.destination_kind as MeetingDestinationKind : null;
    const destinationId = typeof body.destination_id === "string" && UUID_PATTERN.test(body.destination_id) ? body.destination_id : null;
    const clientEventId = typeof body.client_event_id === "string" && UUID_PATTERN.test(body.client_event_id) ? body.client_event_id : null;
    const destination = await validatedDestination(result.supabase, destinationKind, destinationId, clientEventId);
    if (destination.error) return NextResponse.json({ error: destination.error }, { status: 409 });
    const summary = cleanMeetingString(body.summary, 20_000);
    if (!summary) return NextResponse.json({ error: "Meeting summary is required" }, { status: 400 });
    const meetingType = typeof body.meeting_type === "string" && MEETING_TYPES.has(body.meeting_type as MeetingType)
      ? body.meeting_type as MeetingType
      : result.meeting.meeting_type;
    const { data, error } = await result.supabase
      .from("conversation_meeting_minutes")
      .update({
        ...destination.values,
        meeting_type: meetingType,
        summary,
        decisions: cleanMeetingStringList(body.decisions),
        client_requests: cleanMeetingStringList(body.client_requests),
        reslu_actions: cleanMeetingStringList(body.reslu_actions),
        client_actions: cleanMeetingStringList(body.client_actions),
        open_questions: cleanMeetingStringList(body.open_questions),
        important_notes: cleanMeetingStringList(body.important_notes),
        draft_version: expectedVersion + 1,
      })
      .eq("id", result.meeting.id)
      .eq("draft_version", expectedVersion)
      .select()
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "The draft changed. Refresh it before saving." }, { status: 409 });
    return NextResponse.json({ meeting: data });
  }

  if (action === "file") {
    const expectedVersion = Number(body.expected_version);
    if (!Number.isInteger(expectedVersion)) return NextResponse.json({ error: "A valid draft version is required" }, { status: 400 });
    const { data, error } = await result.supabase.rpc("file_conversation_meeting_minutes", {
      p_conversation_id: result.conversationId,
      p_minutes_id: result.meeting.id,
      p_expected_version: expectedVersion,
      p_allow_duplicate: body.allow_duplicate === true,
    }).single();
    if (error) return NextResponse.json({ error: error.message }, { status: /changed|ready|choose|exists|belongs/i.test(error.message) ? 409 : 500 });
    return NextResponse.json({ meeting: data });
  }

  if (action === "discard") {
    if (result.meeting.status === "filed") return NextResponse.json({ error: "Filed minutes cannot be discarded" }, { status: 409 });
    const { data, error } = await result.supabase
      .from("conversation_meeting_minutes")
      .update({ status: "discarded" })
      .eq("id", result.meeting.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ meeting: data });
  }

  return NextResponse.json({ error: "Unsupported meeting action" }, { status: 400 });
}
