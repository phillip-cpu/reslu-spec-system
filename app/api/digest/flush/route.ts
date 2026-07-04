import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { flushDigest } from "@/lib/gmail/digest";

export const runtime = "nodejs";

// Digest send slots — 9am / 12pm / 4pm Adelaide time.
const DIGEST_HOURS = [9, 12, 16];

/**
 * GET /api/digest/flush — Vercel Cron entry point.
 *
 * Vercel Cron runs in UTC and can't express Australia/Adelaide (which
 * is UTC+9:30/+10:30 with DST). So vercel.json fires this hourly-ish at
 * the UTC times that map to the target hours in BOTH DST states, and
 * this handler flushes only when the *Adelaide local hour* is 9/12/16 —
 * correct year-round without touching the schedule for daylight saving.
 *
 * Auth: Vercel adds `Authorization: Bearer $CRON_SECRET` to cron
 * invocations when CRON_SECRET is set, so randoms can't trigger sends.
 * Uses the service-role client (no session in a cron request).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hour = Number(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Adelaide",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date())
  );
  if (!DIGEST_HOURS.includes(hour)) {
    return NextResponse.json({ skipped: `Adelaide ${hour}:00 — not a digest slot` });
  }

  const supabase = createServiceRoleClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const result = await flushDigest(supabase, appUrl);
  return NextResponse.json({ ranAt: `Adelaide ${hour}:00`, ...result });
}

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
