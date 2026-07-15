import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { validLeadMeetingStoragePath, withLeadMeetingUrl } from "@/lib/lead-meetings";
import { createClient } from "@/lib/supabase/server";
import type { LeadMeetingListResponse, LeadMeetingRecording } from "@/types/lead-meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(leadId: string) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (info.role !== "admin") {
    return { response: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  }
  const { data: lead } = await supabase
    .from("leads")
    .select("id,first_name,surname_project")
    .eq("id", leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!lead) return { response: NextResponse.json({ error: "Lead not found" }, { status: 404 }) };
  return { supabase, info, lead };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireAdmin(id);
  if ("response" in auth) return auth.response;

  const { data, error } = await auth.supabase
    .from("lead_meeting_recordings")
    .select("*")
    .eq("lead_id", id)
    .is("deleted_at", null)
    .order("recorded_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const recordings = await Promise.all(
    ((data ?? []) as LeadMeetingRecording[]).map((row) => withLeadMeetingUrl(auth.supabase, row))
  );
  const body: LeadMeetingListResponse = { recordings };
  return NextResponse.json(body);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireAdmin(id);
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const storagePath = typeof body.storage_path === "string" ? body.storage_path.trim() : "";
  const filename = typeof body.original_filename === "string" ? body.original_filename.trim() : "";
  if (!storagePath || !filename || !validLeadMeetingStoragePath(storagePath, id, auth.info.userId)) {
    return NextResponse.json({ error: "A valid uploaded meeting file is required" }, { status: 400 });
  }

  const recordedAt = typeof body.recorded_at === "string" && !Number.isNaN(Date.parse(body.recorded_at))
    ? new Date(body.recorded_at).toISOString()
    : new Date().toISOString();
  const duration = Number(body.duration_seconds);
  const durationSeconds = Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null;

  const { data: existing, error: existingError } = await auth.supabase
    .from("lead_meeting_recordings")
    .select("*")
    .eq("storage_path", storagePath)
    .maybeSingle();
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  if (existing && (existing.lead_id !== id || existing.created_by !== auth.info.userId)) {
    return NextResponse.json({ error: "This meeting upload is already registered" }, { status: 409 });
  }

  let row: LeadMeetingRecording;
  let created = false;
  if (existing) {
    const { data: restored, error: restoreError } = await auth.supabase
      .from("lead_meeting_recordings")
      .update({ deleted_at: null })
      .eq("id", existing.id)
      .select()
      .single();
    if (restoreError) return NextResponse.json({ error: restoreError.message }, { status: 500 });
    row = restored as LeadMeetingRecording;
  } else {
    const { data: inserted, error: insertError } = await auth.supabase
      .from("lead_meeting_recordings")
      .insert({
        lead_id: id,
        storage_path: storagePath,
        original_filename: filename,
        mime_type: typeof body.mime_type === "string" ? body.mime_type.slice(0, 100) : null,
        recorded_at: recordedAt,
        duration_seconds: durationSeconds,
        created_by: auth.info.userId,
      })
      .select()
      .single();
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
    row = inserted as LeadMeetingRecording;
    created = true;
  }

  const leadName = [auth.lead.first_name, auth.lead.surname_project].filter(Boolean).join(" ") || "Lead";
  const { error: queueError } = await auth.supabase.from("aria_queue").upsert(
    {
      kind: "meeting_transcription",
      source: "lead-meeting",
      dedupe_key: `meeting_transcription:${row.id}`,
      payload: {
        recording_id: row.id,
        lead_id: id,
        lead_name: leadName,
        filename,
        instruction:
          "Use get_lead_meeting_recording, transcribe the full audio with local Whisper, prepare a concise factual summary, action items and decisions, then call complete_lead_meeting_transcription. Do not send messages or copy anything into lead notes.",
      },
    },
    { onConflict: "dedupe_key", ignoreDuplicates: true }
  );

  return NextResponse.json(
    {
      recording: await withLeadMeetingUrl(auth.supabase, row),
      transcription_queued: !queueError,
      warning: queueError?.message ?? null,
    },
    { status: created ? 201 : 200 }
  );
}
