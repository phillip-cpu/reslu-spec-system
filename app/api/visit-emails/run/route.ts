import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import {
  adelaideDateString,
  addDaysToDateString,
  adelaideDayRangeUtc,
  flushPendingSends,
  formatVisitDate,
  formatVisitTime,
  leadLastName,
  sendOrQueue,
  suburbFrom,
} from "@/lib/visit-emails";
import type { VisitEmailsRunResult } from "@/types/visit-emails";

export const runtime = "nodejs";

interface LeadReminderRow {
  id: string;
  first_name: string | null;
  surname_project: string;
  email: string | null;
  site_visit_date: string | null;
  site_visit_location: string | null;
  location: string | null;
}

interface ClientEventReminderRow {
  id: string;
  project_id: string;
  starts_at: string;
  location: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  client_name: string;
  client_email: string | null;
  client_secondary_email: string | null;
}

/**
 * GET/POST /api/visit-emails/run — Vercel Cron entry point (also
 * triggerable manually by an admin, e.g. for testing before the cron
 * entry is wired up).
 *
 * Two passes, in order:
 *   1. flushPendingSends() — every email_sends row queued 'pending'
 *      (outside-window sends, or in-window sends that failed and were
 *      queued for retry) whose scheduled_for is now due.
 *   2. Reminder sweep — every non-cancelled lead site visit / client
 *      event happening TOMORROW (Adelaide-local calendar date) gets a
 *      visit-reminder.html send attempt via sendOrQueue(); the same
 *      guard that powers the confirmation send (see
 *      lib/visit-emails.ts's sendOrQueue doc comment) makes this
 *      idempotent across repeated cron runs on the same day — a visit
 *      already reminded for its CURRENT date/time is a silent
 *      'duplicate' no-op, not a second email. A cancelled visit
 *      (site_visit_date cleared, or the client_event soft-deleted)
 *      simply never matches the range query below, so it's naturally
 *      excluded without any extra "is it cancelled" check.
 *
 * Auth: `authorization: Bearer ${CRON_SECRET}` (Vercel Cron's actual
 * call) OR an authenticated ADMIN session. Unlike the digest/trade-
 * reminders/client-events-remind cron routes (which accept ANY team
 * session for their manual-trigger path), this route reads
 * leads.email/site_visit_date directly — admin-only data per
 * app/api/leads/**'s whole-route gate — so the manual-trigger fallback
 * here is held to that same admin gate rather than "any signed-in
 * team member".
 *
 * vercel.json cron line for CC to add (out of this round's edit
 * boundary — see README.md "Site-visit lifecycle emails" section for
 * the full write-up):
 *   { "path": "/api/visit-emails/run", "schedule": "45 21 * * *" }
 * 21:45 UTC = 07:15 ACST (South Australia standard time, winter) — a
 * few minutes after the 7am window opens, so the "tomorrow" reminder
 * sweep and any overnight-queued pending sends flush promptly once
 * sending is allowed. DST CAVEAT (same limitation already documented
 * on every other fixed-UTC cron line in this codebase, e.g. README.md's
 * "Daily Brief cron" section): this fires at 08:15 ACDT during South
 * Australia's daylight-saving window (roughly October-April), not
 * 7:15am, since Vercel Cron always runs in UTC with no DST adjustment.
 * Low-stakes here — sendOrQueue()/flushPendingSends() both re-check the
 * Adelaide window themselves at send time regardless of when the cron
 * fires, so a run landing an hour "late" during DST still only ever
 * sends inside 7am-7pm Adelaide; the only visible effect is reminders
 * landing slightly later than 7:15am local during DST months.
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
      return NextResponse.json({ error: "Only admins can run visit-emails" }, { status: 403 });
    }
  }

  // Service-role client either way past this point: the cron path has
  // no user session to bind a request-scoped client to (same reasoning
  // as every other cron route in this codebase), and the admin-session
  // path still needs to read leads/client_events/projects across the
  // whole team's data, not just RLS-visible rows for one user (Phase 1
  // RLS is permissive team_all everywhere anyway, so this carries no
  // extra exposure).
  const supabase = createServiceRoleClient();
  const now = new Date();

  let flushed;
  try {
    flushed = await flushPendingSends(supabase, now);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Flush failed" },
      { status: 500 }
    );
  }

  const reminders = { sent: 0, queued: 0, skipped: 0 };

  const tomorrow = addDaysToDateString(adelaideDateString(now), 1);
  const { start, end } = adelaideDayRangeUtc(tomorrow);

  // ---- Lead site visits ----
  const { data: leadRows } = await supabase
    .from("leads")
    .select("id,first_name,surname_project,email,site_visit_date,site_visit_location,location")
    .is("deleted_at", null)
    .not("site_visit_date", "is", null)
    .gte("site_visit_date", start.toISOString())
    .lt("site_visit_date", end.toISOString());

  for (const lead of (leadRows ?? []) as LeadReminderRow[]) {
    if (!lead.email || !lead.site_visit_date) {
      reminders.skipped++;
      continue;
    }
    const visitDatetime = lead.site_visit_date;
    const result = await sendOrQueue(supabase, {
      recordType: "lead",
      recordId: lead.id,
      template: "visit-reminder",
      to: [lead.email],
      subject: `Your site visit tomorrow — ${formatVisitDate(visitDatetime)}`,
      mergeData: {
        first_name: lead.first_name,
        last_name: leadLastName(lead.surname_project),
        visit_date: formatVisitDate(visitDatetime),
        visit_time: formatVisitTime(visitDatetime),
        suburb: suburbFrom(lead.site_visit_location || lead.location),
      },
      visitDatetime,
      now,
    });
    if (result.action === "sent") reminders.sent++;
    else if (result.action === "queued") reminders.queued++;
    else reminders.skipped++;
  }

  // ---- Client events ----
  const { data: eventRows } = await supabase
    .from("client_events")
    .select("id,project_id,starts_at,location")
    .is("deleted_at", null)
    .gte("starts_at", start.toISOString())
    .lt("starts_at", end.toISOString());

  const typedEvents = (eventRows ?? []) as ClientEventReminderRow[];
  const projectIds = [...new Set(typedEvents.map((e) => e.project_id))];
  const { data: projectRows } = projectIds.length
    ? await supabase
        .from("projects")
        .select("id,name,client_name,client_email,client_secondary_email")
        .in("id", projectIds)
    : { data: [] as ProjectRow[] };
  const projectById = new Map((projectRows ?? []).map((p) => [p.id, p as ProjectRow]));

  for (const event of typedEvents) {
    const project = projectById.get(event.project_id);
    if (!project) {
      reminders.skipped++;
      continue;
    }
    const to = [project.client_email, project.client_secondary_email].filter(
      (e): e is string => !!e
    );
    if (to.length === 0) {
      reminders.skipped++;
      continue;
    }
    // client_events has no separate first/last name field — split the
    // project's client_name on its first space (best-effort, same
    // "free text, not a structured name field" caveat as
    // leadLastName()); a single-word client_name puts the whole thing
    // in first_name and leaves last_name blank rather than guessing.
    const [firstName, ...rest] = project.client_name.split(" ");
    const visitDatetime = event.starts_at;
    const result = await sendOrQueue(supabase, {
      recordType: "client_event",
      recordId: event.id,
      template: "visit-reminder",
      to,
      subject: `Your site visit tomorrow — ${formatVisitDate(visitDatetime)}`,
      mergeData: {
        first_name: firstName || project.client_name,
        last_name: rest.join(" "),
        visit_date: formatVisitDate(visitDatetime),
        visit_time: formatVisitTime(visitDatetime),
        suburb: suburbFrom(event.location),
      },
      visitDatetime,
      now,
    });
    if (result.action === "sent") reminders.sent++;
    else if (result.action === "queued") reminders.queued++;
    else reminders.skipped++;
  }

  const body: VisitEmailsRunResult = { flushed, reminders };
  return NextResponse.json(body);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
