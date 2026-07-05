import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { sendDueReminders } from "@/lib/client-event-reminders";

export const runtime = "nodejs";

/**
 * POST /api/client-events/remind
 *
 * "Day before" client-event reminder trigger — BUILD-SPEC.md §"Portal
 * — upcoming client meetings": "Reminder email to client the day
 * before via notify-client." vercel.json is out of this task's file
 * boundary (owned by the on-machine engineer alongside the other
 * cron entries) — see this feature's README note and this task's
 * final report for the exact cron line to add
 * (`{ "path": "/api/client-events/remind", "schedule": "0 21 * * *" }`,
 * identical UTC slot to the existing /api/trade-reminders entry, which
 * lands this at 21:00 UTC = a fixed daily run well ahead of any
 * Adelaide morning).
 *
 * Auth: identical dual-path pattern to
 * app/api/trade-reminders/route.ts and app/api/digest/flush/route.ts —
 * accepts EITHER `authorization: Bearer ${CRON_SECRET}` (the future
 * cron entry's actual call) OR an authenticated team session (manual
 * "run reminders now" trigger, e.g. for testing before the cron entry
 * exists). Exported as BOTH GET and POST (see the `export const GET =
 * POST` alias below) since Vercel Cron only ever issues GET
 * (/api/trade-reminders' and /api/digest/flush's own cron entries are
 * both GET) while a manual/testing trigger reads more naturally as a
 * POST — this route accepts either verb identically rather than
 * forcing the on-machine engineer to pick one when wiring the second
 * cron entry.
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();

  try {
    const result = await sendDueReminders(supabase);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reminder send failed" },
      { status: 500 }
    );
  }
}

/** Vercel Cron issues GET; alias so the future cron entry works with either verb without a second route file. */
export const GET = POST;
