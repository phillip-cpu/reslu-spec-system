import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { generateDailyBrief } from "@/lib/daily-brief-generate";
import { buildBriefEmailContent, type BriefEmailItem } from "@/lib/daily-brief";
import { sendTeamEmail, isGmailConfigured } from "@/lib/gmail/send";
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
 * brief items." + "Email: 7am cron (same or second schedule) sends the
 * glance email."
 *
 * ONE route serves both jobs via a query flag rather than two separate
 * files, since "generate, then optionally email what's now open" is a
 * single linear sequence with no reason to split into two HTTP round-
 * trips — `?send=1` runs the email step immediately after generating
 * (see this task's final report for the exact vercel.json cron line,
 * e.g. `{"path": "/api/brief/generate?send=1", "schedule": "30 21 * * *"}`
 * — 7:00am ACST during winter; see that report's own DST caveat).
 * Calling this route with NO `send` param (e.g. a manual "regenerate"
 * trigger from the panel, or testing) generates without emailing.
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
  const sendEmail = new URL(request.url).searchParams.get("send") === "1";

  let result;
  try {
    result = await generateDailyBrief(supabase);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Daily Brief generation failed" },
      { status: 500 }
    );
  }

  const body: GenerateBriefResponse = { ...result };

  if (sendEmail) {
    body.email = await sendBriefEmailIfNeeded(supabase, result.brief_date);
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
    .select("source,title,brief_date")
    .eq("status", "open")
    .order("brief_date", { ascending: true })
    .order("created_at", { ascending: true });
  const openItems = (openRows ?? []) as BriefEmailItem[];

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
