import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { flushDigest } from "@/lib/gmail/digest";

export const runtime = "nodejs";

// Digest send slots — 9am / 12pm / 4pm Adelaide time (client's request).
const DIGEST_HOURS = [9, 12, 16];

/**
 * GET /api/digest/flush — Vercel Cron entry point.
 *
 * Vercel Cron issues GET requests (not POST), and runs in UTC — it can't
 * express Australia/Adelaide (UTC+9:30 / +10:30 with DST). So vercel.json
 * fires this at the UTC times that map to 9/12/4pm Adelaide in BOTH DST
 * states, and this handler only actually flushes when the Adelaide local
 * hour is 9/12/16 — correct year-round with no schedule edits for
 * daylight saving. Auth: `authorization: Bearer ${CRON_SECRET}` (Vercel
 * adds it automatically to cron calls when the env var is set); uses the
 * service-role client since a cron call has no session. The POST handler
 * below stays for the manual "Send digest" trigger (any hour, on demand).
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
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
 *
 * Manual "Send digest" trigger (any signed-in team member) or an external
 * POST scheduler with the CRON_SECRET bearer. Vercel's own Cron uses the
 * GET handler above; this stays for on-demand sends.
 * Vercel's cron invoker makes a plain server-to-server HTTP call with
 * no browser session, so the original session-only auth check would
 * 401 every scheduled run. Now accepts EITHER:
 *   - an authenticated team session (unchanged — the manual "Send
 *     digest" trigger keeps working exactly as before), OR
 *   - header `authorization: Bearer ${CRON_SECRET}` (see
 *     .env.local.example / README.md for how to set CRON_SECRET in
 *     Vercel's project environment variables — Vercel automatically
 *     sends this header on its own cron invocations when the env var
 *     is named CRON_SECRET, per Vercel's cron documentation, but this
 *     route checks it explicitly rather than trusting the platform, so
 *     it also works if triggered by any other external scheduler).
 *
 * Sending a digest isn't a destructive action either way — it only
 * ever emails admins and only ever sends pending rows already queued
 * by real client actions — so this stays deliberately not admin-gated
 * for the session path, matching the pre-Week-7 behaviour.
 *
 * Sends every pending portal_digest_queue row, grouped per project, to
 * all admin profiles, then marks those rows sent_at. See
 * lib/gmail/digest.ts for the full design rationale (queue + flush
 * instead of send-on-every-click).
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  // The cron path has no user session to bind a request-scoped client
  // to, so it uses the service-role client (same reasoning as every
  // other fire-and-forget/background job in this codebase — e.g.
  // lib/scraper/index.ts, the Monday sync in app/api/items/[id]/route.ts).
  // flushDigest() only reads portal_digest_queue/profiles and sends
  // email; it never touches per-user-scoped data, so bypassing RLS here
  // carries the same low risk as those other service-role call sites.
  let supabase;
  if (isCronCall) {
    supabase = createServiceRoleClient();
  } else {
    supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
