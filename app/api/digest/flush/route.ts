import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { flushDigest } from "@/lib/gmail/digest";

export const runtime = "nodejs";

/**
 * POST /api/digest/flush
 * Auth required (any signed-in team member — sending a digest isn't a
 * destructive action, so it isn't admin-gated; it only ever emails
 * admins and only ever sends pending rows already queued by real
 * client actions).
 *
 * Sends every pending portal_digest_queue row, grouped per project, to
 * all admin profiles, then marks those rows sent_at. See
 * lib/gmail/digest.ts for the full design rationale (queue + flush
 * instead of send-on-every-click).
 *
 * No cron wiring in this codebase — call this route from an external
 * scheduler (Vercel Cron, an uptime ping, or a manual "Send digest"
 * button in the UI) on whatever cadence is wanted.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  try {
    const result = await flushDigest(supabase, appUrl);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Digest flush failed" },
      { status: 500 }
    );
  }
}
