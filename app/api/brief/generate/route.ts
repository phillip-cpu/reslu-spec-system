import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { generateDailyBrief } from "@/lib/daily-brief-generate";
import { buildBriefEmailContent, type BriefEmailItem } from "@/lib/daily-brief";
import { sendTeamEmail, isGmailConfigured } from "@/lib/gmail/send";
import { adelaideHour, isMorningBriefDeliveryHour, rankMorningBriefItems } from "@/lib/morning-brief";
import { notifyMorningBrief } from "@/lib/morning-brief-notify";
import { recordJobRun } from "@/lib/job-runs";
import type { GenerateBriefResponse } from "@/types/round-daily-brief";

export const runtime = "nodejs";

const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "8 July 2026" — no Intl/toLocaleDateString (same manual-array discipline this codebase already uses everywhere a date renders, e.g. components/my-work/MyWorkWorkspace.tsx's SHORT_MONTHS — here purely for a consistent, deterministic subject line, not a hydration concern since this route never renders to a browser). */
function formatBriefDateLong(dateOnly: string): string {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return `${d} ${FULL_MONTHS[m - 1]} ${y}`;
}

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "https://spec.reslu.com.au"
  ).replace(/\/+$/, "");
}

/**
 * GET/POST /api/brief/generate
 * BUILD-SPEC.md "Daily Brief": "Generation: morning cron (route w/
 * CRON_SECRET pattern; CC adds the vercel.json cron line — documented,
 * file protected) aggregates the existing attention feeds ... into
 * brief items." The production cron also requests one morning push per
 * admin; the optional glance email remains available separately.
 *
 * Query flags keep the side effects explicit: `?notify=1` creates the
 * private per-admin push and `?send=1` sends the email. Vercel calls the
 * notification path at both UTC offsets that can be 7am in Adelaide; the
 * local-hour gate below accepts exactly one, so DST cannot shift delivery.
 * Calling the route with neither flag only regenerates the list.
 *
 * Auth: dual-path, mirroring app/api/client-events/remind's/
 * app/api/digest/flush's exact CRON_SECRET-or-session shape — but
 * ADMIN-gated on the session path (not "any signed-in team member"),
 * since this generator reads admin-only-sourced feeds (leads,
 * ordering/lead_time_weeks) — see this round's "brief admin-gating
 * consistent" verification note. GET is aliased to POST since Vercel
 * Cron only ever issues GET (same alias pattern as
 * app/api/client-events/remind), while a manual trigger reads more
 * naturally as a POST.
 */
async function handle(request: NextRequest) {
  const startedAt = new Date();
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const info = await getUserRole(supabase);
    if (!info) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (info.role !== "admin") {
      return NextResponse.json(
        { error: "Only admins can run the Daily Brief generator — it aggregates admin-only lead/ordering data." },
        { status: 403 }
      );
    }
  }

  const supabase = createServiceRoleClient();
  const searchParams = new URL(request.url).searchParams;
  const sendEmail = searchParams.get("send") === "1";
  const sendNotification = searchParams.get("notify") === "1";

  // Vercel schedules both UTC offsets that can map to 7am in Adelaide.
  // Only one is the real delivery slot on a given date; this gate makes the
  // schedule daylight-saving-safe without seasonal config changes.
  if (isCronCall && !isMorningBriefDeliveryHour(startedAt)) {
    return NextResponse.json({
      skipped: `Adelaide ${adelaideHour(startedAt)}:00 — not the 7am Morning Brief slot`,
    });
  }

  let result;
  try {
    result = await generateDailyBrief(supabase, startedAt);
  } catch (err) {
    if (isCronCall) {
      await recordJobRun(supabase, {
        jobKey: "brief_generate",
        status: "failed",
        startedAt,
        error: err instanceof Error ? err.message : "Daily Brief generation failed",
      });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Daily Brief generation failed" },
      { status: 500 }
    );
  }

  const body: GenerateBriefResponse = { ...result };

  if (sendEmail) {
    body.email = await sendBriefEmailIfNeeded(supabase, result.brief_date);
  }

  let deliveryDegraded = false;
  if (sendNotification) {
    try {
      body.notification = await notifyMorningBrief(supabase, result.brief_date, startedAt);
      deliveryDegraded =
        body.notification.recipient_failures > 0 ||
        body.notification.push.failed > 0 ||
        (body.notification.notifications_created > 0 &&
          (!body.notification.push.configured || body.notification.push.attempted === 0));
    } catch (err) {
      deliveryDegraded = true;
      body.notification = {
        notifications_created: 0,
        recipients_deduped: 0,
        recipient_failures: 1,
        item_count: 0,
        push: { configured: false, attempted: 0, delivered: 0, stale: 0, failed: 0 },
        skipped: err instanceof Error ? err.message : "Morning Brief notification failed",
      };
    }
  }

  if (isCronCall) {
    await recordJobRun(supabase, {
      jobKey: "brief_generate",
      status: deliveryDegraded ? "degraded" : "succeeded",
      startedAt,
      summary: { ...body },
      error: deliveryDegraded ? body.notification?.skipped ?? "Morning Brief push delivery was incomplete" : null,
    });
  }

  return NextResponse.json(body);
}

/**
 * The 7am glance email — BUILD-SPEC.md: "sends the glance email
 * (counts + top items + one button to /my-work) via sendTeamEmail to
 * admins; skips when zero items." Reflects the FULL current open brief
 * (every open item, not just ones this run just created — a
 * carried-over item is just as much part of "today's brief" as a
 * fresh one) so the email matches exactly what GET /api/brief itself
 * would show a moment later. No-op cleanly (returns `{ sent: false,
 * skipped: reason }`, never throws) when Gmail isn't configured or
 * there are zero admins/zero open items — mirrors
 * lib/notify-client.ts's/lib/gmail/digest.ts's own best-effort
 * "never fail the caller's primary action" contract, even though here
 * the "primary action" (generation) has already committed by the time
 * this runs.
 */
async function sendBriefEmailIfNeeded(
  supabase: ReturnType<typeof createServiceRoleClient>,
  briefDate: string
): Promise<GenerateBriefResponse["email"]> {
  if (!isGmailConfigured()) {
    return { sent: false, skipped: "Gmail credentials not configured" };
  }

  const { data: openRows } = await supabase
    .from("daily_brief_items")
    .select("id,source,title,brief_date,created_at")
    .eq("status", "open")
    .order("created_at", { ascending: true });
  const openItems = rankMorningBriefItems(
    (openRows ?? []) as Array<BriefEmailItem & { id: string; brief_date: string; created_at: string }>
  );

  if (openItems.length === 0) {
    return { sent: false, skipped: "No open brief items", item_count: 0 };
  }

  const { data: admins } = await supabase.from("profiles").select("email").eq("role", "admin");
  const adminEmails = (admins ?? []).map((p: { email: string }) => p.email).filter(Boolean);
  if (adminEmails.length === 0) {
    return { sent: false, skipped: "No admin recipients", item_count: openItems.length };
  }

  const { subject, body } = buildBriefEmailContent(openItems, formatBriefDateLong(briefDate), appUrl());

  const result = await sendTeamEmail({ to: adminEmails, subject, body });
  if (result.skipped) {
    return { sent: false, skipped: result.reason ?? "Send skipped", item_count: openItems.length };
  }
  return { sent: true, item_count: openItems.length };
}

export const GET = handle;
export const POST = handle;
