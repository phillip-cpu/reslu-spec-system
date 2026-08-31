import { NextRequest, NextResponse } from "next/server";
import { recordJobRun } from "@/lib/job-runs";
import { ASSET_BUCKET } from "@/lib/storage";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TERMINAL_MEETING_STATUSES = ["review", "filed", "discarded", "failed"];
const RECORDING_BATCH_SIZE = 25;
const TRANSCRIPT_BATCH_SIZE = 100;

interface RecordingSourceRow {
  id: string;
  recording_storage_path: string;
}

async function handle(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const startedAt = new Date();
  const { data: policy, error: policyError } = await service
    .from("meeting_source_retention_policy")
    .select("enabled")
    .eq("singleton", true)
    .single();
  if (policyError) {
    await recordJobRun(service, {
      jobKey: "meeting_source_retention",
      status: "failed",
      startedAt,
      error: policyError.message,
    });
    return NextResponse.json({ error: "Meeting retention policy could not be read" }, { status: 500 });
  }
  if (!policy?.enabled) {
    const body = { ok: true, skipped: "Automatic meeting-source deletion is disabled" };
    await recordJobRun(service, {
      jobKey: "meeting_source_retention",
      status: "succeeded",
      startedAt,
      summary: { enabled: false, recordings_purged: 0, transcripts_purged: 0 },
    });
    return NextResponse.json(body);
  }

  const now = new Date().toISOString();
  const errors: string[] = [];
  let recordingsPurged = 0;
  let transcriptsPurged = 0;

  const { data: recordingRows, error: recordingQueryError } = await service
    .from("conversation_meeting_minutes")
    .select("id,recording_storage_path")
    .in("status", TERMINAL_MEETING_STATUSES)
    .lte("recording_retain_until", now)
    .is("recording_deleted_at", null)
    .not("recording_storage_path", "is", null)
    .order("recording_retain_until", { ascending: true })
    .limit(RECORDING_BATCH_SIZE);
  if (recordingQueryError) errors.push(`recording query: ${recordingQueryError.message}`);

  for (const source of (recordingRows ?? []) as RecordingSourceRow[]) {
    const removed = await service.storage.from(ASSET_BUCKET).remove([source.recording_storage_path]);
    if (removed.error) {
      errors.push(`recording ${source.id}: ${removed.error.message}`);
      continue;
    }
    const finalized = await service.rpc("finalize_meeting_source_retention_purge", {
      p_minutes_id: source.id,
      p_kind: "recording",
    });
    if (finalized.error) errors.push(`recording ${source.id}: ${finalized.error.message}`);
    else if (finalized.data === true) recordingsPurged++;
  }

  const { data: transcriptRows, error: transcriptQueryError } = await service
    .from("conversation_meeting_minutes")
    .select("id")
    .in("status", TERMINAL_MEETING_STATUSES)
    .lte("transcript_retain_until", now)
    .is("transcript_deleted_at", null)
    .not("transcript", "is", null)
    .order("transcript_retain_until", { ascending: true })
    .limit(TRANSCRIPT_BATCH_SIZE);
  if (transcriptQueryError) errors.push(`transcript query: ${transcriptQueryError.message}`);

  for (const source of transcriptRows ?? []) {
    const finalized = await service.rpc("finalize_meeting_source_retention_purge", {
      p_minutes_id: source.id,
      p_kind: "transcript",
    });
    if (finalized.error) errors.push(`transcript ${source.id}: ${finalized.error.message}`);
    else if (finalized.data === true) transcriptsPurged++;
  }

  const status = errors.length > 0 ? "degraded" : "succeeded";
  await recordJobRun(service, {
    jobKey: "meeting_source_retention",
    status,
    startedAt,
    summary: {
      enabled: true,
      recordings_purged: recordingsPurged,
      transcripts_purged: transcriptsPurged,
      failures: errors.length,
    },
    error: errors.join(" | ") || null,
  });

  return NextResponse.json({
    ok: errors.length === 0,
    status,
    recordings_purged: recordingsPurged,
    transcripts_purged: transcriptsPurged,
    failures: errors.length,
  }, { status: errors.length > 0 ? 207 : 200 });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
