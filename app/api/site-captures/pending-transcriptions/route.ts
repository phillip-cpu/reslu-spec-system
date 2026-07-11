import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { withCaptureUrl } from "@/lib/site-captures";
import type { PendingTranscriptionEntry, PendingTranscriptionsResponse, SiteCapture } from "@/types/site-captures";

export const runtime = "nodejs";

/**
 * GET /api/site-captures/pending-transcriptions
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 5. Audio
 * captures (kind='audio') still queued for transcription
 * (transcript_status='pending'), oldest first (FIFO) — the exact queue
 * Aria's Mac mini (local Whisper — no external AI, per the standing
 * ruling) polls via the MCP list_pending_transcriptions tool
 * (mcp/src/index.mjs), which is a thin fetch to this route. Each entry
 * carries id + a signed audio URL + which project it belongs to, per
 * the spec's own wording. Team-authenticated (Aria's account signs in
 * via lib/supabase/server.ts's Bearer-token path, same as every other
 * MCP-backed route).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: rows, error } = await supabase
    .from("site_captures")
    .select("*")
    .eq("kind", "audio")
    .eq("transcript_status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const captures = (rows ?? []) as SiteCapture[];
  const projectIds = [...new Set(captures.map((c) => c.project_id))];
  const { data: projects } = projectIds.length
    ? await supabase.from("projects").select("id,name").in("id", projectIds)
    : { data: [] as { id: string; name: string }[] };
  const projectById = new Map((projects ?? []).map((p) => [p.id, p]));

  const entries: PendingTranscriptionEntry[] = await Promise.all(
    captures.map(async (c) => {
      const withUrl = await withCaptureUrl(supabase, c);
      return {
        id: c.id,
        project_id: c.project_id,
        project_name: projectById.get(c.project_id)?.name ?? null,
        url: withUrl.url,
        created_at: c.created_at,
      };
    })
  );

  const body: PendingTranscriptionsResponse = { captures: entries };
  return NextResponse.json(body);
}
