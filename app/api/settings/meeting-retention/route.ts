import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import {
  cleanMeetingSourceRetentionUpdate,
  type MeetingSourceRetentionDueCounts,
  type MeetingSourceRetentionPolicy,
} from "@/lib/meeting-retention";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_MEETING_STATUSES = ["review", "filed", "discarded", "failed"];

async function dueSourceCounts(): Promise<MeetingSourceRetentionDueCounts> {
  const service = createServiceRoleClient();
  const now = new Date().toISOString();
  const [recordings, transcripts] = await Promise.all([
    service
      .from("conversation_meeting_minutes")
      .select("id", { count: "exact", head: true })
      .in("status", TERMINAL_MEETING_STATUSES)
      .lte("recording_retain_until", now)
      .is("recording_deleted_at", null)
      .not("recording_storage_path", "is", null),
    service
      .from("conversation_meeting_minutes")
      .select("id", { count: "exact", head: true })
      .in("status", TERMINAL_MEETING_STATUSES)
      .lte("transcript_retain_until", now)
      .is("transcript_deleted_at", null)
      .not("transcript", "is", null),
  ]);
  if (recordings.error) throw new Error(recordings.error.message);
  if (transcripts.error) throw new Error(transcripts.error.message);
  return { recordings: recordings.count ?? 0, transcripts: transcripts.count ?? 0 };
}

export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("meeting_source_retention_policy")
    .select("*")
    .eq("singleton", true)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Meeting retention policy is unavailable" }, { status: 500 });
  }

  try {
    return NextResponse.json({
      policy: data as MeetingSourceRetentionPolicy,
      can_edit: info.role === "admin",
      due: info.role === "admin" ? await dueSourceCounts() : null,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (reason) {
    return NextResponse.json({
      error: reason instanceof Error ? reason.message : "Meeting retention status is unavailable",
    }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can change meeting source retention" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const update = cleanMeetingSourceRetentionUpdate(raw);
  if (!update) {
    return NextResponse.json({
      error: "Choose whole-day retention periods, keep transcripts at least as long as recordings, and confirm automatic deletion explicitly",
    }, { status: 400 });
  }

  const service = createServiceRoleClient();
  const { data, error } = await service.rpc("set_meeting_source_retention_policy", {
    p_recording_days: update.recordingDays,
    p_transcript_days: update.transcriptDays,
    p_enabled: update.action === "enable",
    p_actor_id: info.userId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const policy = (Array.isArray(data) ? data[0] : data) as MeetingSourceRetentionPolicy | null;
  if (!policy) return NextResponse.json({ error: "Meeting retention policy was not saved" }, { status: 500 });

  return NextResponse.json({ policy, due: await dueSourceCounts() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
