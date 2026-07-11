import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { withCaptureUrl } from "@/lib/site-captures";
import type { SetCaptureTranscriptInput, SiteCaptureResponse } from "@/types/site-captures";

export const runtime = "nodejs";

/**
 * PATCH /api/site-captures/[id]/transcript
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 5.
 * body: { transcript }. Sets transcript + transcript_status='done'.
 * Only valid for kind='audio' rows — every photo/note row has
 * transcript_status=null per migration 050's
 * chk_site_captures_transcript_audio_only CHECK, so a PATCH against
 * one of those 400s rather than silently succeeding.
 *
 * Team-authenticated, not admin-gated (site diary data carries no
 * pricing). MCP: set_capture_transcript (mcp/src/index.mjs) — Aria's
 * Mac mini (local Whisper) calls this once it has produced a
 * transcript for a queued row (see GET
 * /api/site-captures/pending-transcriptions).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: existing } = await supabase
    .from("site_captures")
    .select("id,kind")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Capture not found" }, { status: 404 });
  }
  if (existing.kind !== "audio") {
    return NextResponse.json({ error: "Only audio captures can carry a transcript." }, { status: 400 });
  }

  let body: SetCaptureTranscriptInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from("site_captures")
    .update({ transcript, transcript_status: "done" })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const responseBody: SiteCaptureResponse = { capture: await withCaptureUrl(supabase, row) };
  return NextResponse.json(responseBody);
}
