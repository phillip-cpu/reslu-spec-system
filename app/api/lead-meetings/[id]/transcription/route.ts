import { NextRequest, NextResponse } from "next/server";
import { cleanStringList, withLeadMeetingUrl } from "@/lib/lead-meetings";
import { createClient } from "@/lib/supabase/server";
import type { CompleteLeadMeetingTranscriptionInput, LeadMeetingRecording } from "@/types/lead-meetings";

export const runtime = "nodejs";

async function authenticatedRecording(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data } = await supabase
    .from("lead_meeting_recordings")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return { response: NextResponse.json({ error: "Recording not found" }, { status: 404 }) };
  return { supabase, recording: data as LeadMeetingRecording };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await authenticatedRecording(id);
  if ("response" in result) return result.response;
  if (result.recording.transcript_status === "pending") {
    await result.supabase
      .from("lead_meeting_recordings")
      .update({ transcript_status: "processing", failure_note: null })
      .eq("id", id)
      .eq("transcript_status", "pending");
    result.recording.transcript_status = "processing";
  }
  return NextResponse.json({ recording: await withLeadMeetingUrl(result.supabase, result.recording) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await authenticatedRecording(id);
  if ("response" in result) return result.response;

  const body = (await request.json().catch(() => null)) as CompleteLeadMeetingTranscriptionInput | null;
  if (!body || (body.status !== "done" && body.status !== "failed")) {
    return NextResponse.json({ error: "status must be done or failed" }, { status: 400 });
  }

  if (body.status === "failed") {
    const failureNote = typeof body.failure_note === "string" ? body.failure_note.trim() : "Transcription failed";
    const { data, error } = await result.supabase
      .from("lead_meeting_recordings")
      .update({ transcript_status: "failed", failure_note: failureNote })
      .eq("id", id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ recording: await withLeadMeetingUrl(result.supabase, data) });
  }

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) return NextResponse.json({ error: "transcript is required when status is done" }, { status: 400 });
  const { data, error } = await result.supabase
    .from("lead_meeting_recordings")
    .update({
      transcript_status: "done",
      transcript,
      summary: typeof body.summary === "string" ? body.summary.trim() || null : null,
      action_items: cleanStringList(body.action_items),
      decisions: cleanStringList(body.decisions),
      failure_note: null,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ recording: await withLeadMeetingUrl(result.supabase, data) });
}

