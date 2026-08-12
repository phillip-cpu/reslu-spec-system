import { NextRequest, NextResponse } from "next/server";
import { MAX_MEETING_AUDIO_BYTES, meetingRecordingStoragePath } from "@/lib/meeting-mode";
import { requireMeetingModeAccess } from "@/lib/meeting-mode-server";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; meetingId: string }> },
) {
  const { id, meetingId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireMeetingModeAccess(supabase, id, user.id);
  if (access.error) return NextResponse.json({ error: access.error }, { status: 404 });

  const { data: meeting } = await supabase
    .from("conversation_meeting_minutes")
    .select("id,created_by,status")
    .eq("id", meetingId)
    .eq("conversation_id", id)
    .maybeSingle();
  if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  if (meeting.created_by !== user.id) return NextResponse.json({ error: "Only the recorder can upload this meeting audio" }, { status: 403 });
  if (!["recording", "paused", "failed"].includes(meeting.status)) {
    return NextResponse.json({ error: "This meeting is no longer accepting audio" }, { status: 409 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const filename = typeof body?.filename === "string" ? body.filename.trim().slice(0, 240) : "meeting-audio.m4a";
  const byteSize = Number(body?.byte_size);
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_MEETING_AUDIO_BYTES) {
    return NextResponse.json({ error: "Meeting audio must be between 1 byte and 250 MB" }, { status: 400 });
  }
  const path = meetingRecordingStoragePath(id, user.id, meetingId, filename || "meeting-audio.m4a");
  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ path: data.path, token: data.token });
}
