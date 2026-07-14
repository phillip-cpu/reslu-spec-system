import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import {
  adelaideDateString,
  addDaysToDateString,
  adelaideDayRangeUtc,
  DEFAULT_PHILLIP_PHONE,
  flushPendingSends,
  formatVisitDate,
  formatVisitTime,
  leadLastName,
  sendOrQueue,
  suburbFrom,
} from "@/lib/visit-emails";
import { flushPendingProposalSends } from "@/lib/proposal-emails";
import { briefUrlFor, buildLeadVisitCalendarAssets, ensureBriefToken } from "@/lib/lead-brief";
import { reportError } from "@/lib/report-error";
import { recordJobRun } from "@/lib/job-runs";
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
  // Lead flow round (048).
  brief_token: string | null;
  visit_ics_sequence: number;
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
 *   2. Reminder sweep — TWO SEPARATE windows as of the lead flow round
 *      (migration 048), deliberately no longer sharing one "tomorrow"
 *      date:
 *        - LEAD site visits: docs/RESLU-lead-flow-brief.md build task 4
 *          calls for a reminder "48 hours before the visit." This is an
 *          hourly idempotent cron (see vercel.json), but the data model
 *          stores a visit time rather than a separate reminder schedule,
 *          so the honest approximation
 *          is "the Adelaide calendar day two days from today"
 *          (`addDaysToDateString(adelaideToday, 2)`), which lands
 *          anywhere from ~36h to ~60h before the visit depending what
 *          time of day the visit itself is booked for, always inside a
 *          day of the "48 hours" the brief asks for. Carries
 *          {{brief_link}} (lazily-minted /brief/[token], see
 *          lib/lead-brief.ts) and an invite.ics attachment — see the
 *          lead loop below.
 *        - CLIENT EVENTS: UNCHANGED from the r15 "Site-visit lifecycle
 *          emails" round — still TOMORROW (`+1` day), since this
 *          round's brief (docs/RESLU-lead-flow-brief.md) only ever
 *          discusses the lead site-visit journey; client_events' own
 *          brief (docs/RESLU-Spec-Visit-Emails-Brief.md) explicitly
 *          says "the day before," and nothing in this round's
 *          instructions asks that to change.
 *      Both use sendOrQueue()'s same guard (see lib/visit-emails.ts's
 *      doc comment) to stay idempotent across repeated hourly cron
 *      runs — a visit already reminded for its CURRENT date/time is a
 *      silent 'duplicate' no-op, not a second email. A cancelled visit
 *      (site_visit_date cleared, or the client_event soft-deleted)
 *      simply never matches its range query below, so it's naturally
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
 * vercel.json runs this route at minute 15 every hour. That gives a
 * transient failure another attempt within about an hour instead of
 * waiting until the next day. sendOrQueue()/flushPendingSends() still
 * enforce the Adelaide 7am-7pm delivery window and the dedupe guard,
 * so the higher check frequency cannot create duplicate or overnight
 * messages.
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
  const startedAt = new Date();
  const now = startedAt;
  const errors: string[] = [];

  let flushed;
  try {
    flushed = await flushPendingSends(supabase, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Visit-email flush failed";
    await reportError("visit-emails", err);
    errors.push(message);
    // Continue into the reminder sweeps: a broken pending-row flush
    // must not prevent a newly-due client from receiving a reminder.
    flushed = { sent: 0, skipped: 0, failed: 1, stillPending: 0 };
  }

  // Proposal-sent emails share this same daily flush entry point (see
  // lib/proposal-emails.ts's flushPendingProposalSends doc comment) —
  // a failure here must not skip the reminder sweep below, same
  // "one record's problem doesn't cost every other record" contract
  // as the per-lead try/catch further down.
  let proposalsFlushed;
  try {
    proposalsFlushed = await flushPendingProposalSends(supabase, now);
  } catch (err) {
    await reportError("proposal-emails", err);
    errors.push(err instanceof Error ? err.message : "Proposal-email flush failed");
    proposalsFlushed = { sent: 0, skipped: 0, failed: 0, stillPending: 0 };
  }

  const reminders = { sent: 0, queued: 0, skipped: 0 };

  // Lead flow round (048) — see this route's own header comment for
  // why leads and client_events now use DIFFERENT day offsets.
  const leadReminderDate = addDaysToDateString(adelaideDateString(now), 2);
  const { start: leadStart, end: leadEnd } = adelaideDayRangeUtc(leadReminderDate);

  const tomorrow = addDaysToDateString(adelaideDateString(now), 1);
  const { start, end } = adelaideDayRangeUtc(tomorrow);

  // ---- Lead site visits ----
  const { data: leadRows, error: leadRowsError } = await supabase
    .from("leads")
    .select(
      "id,first_name,surname_project,email,site_visit_date,site_visit_location,location,brief_token,visit_ics_sequence"
    )
    .is("deleted_at", null)
    .not("site_visit_date", "is", null)
    .gte("site_visit_date", leadStart.toISOString())
    .lt("site_visit_date", leadEnd.toISOString());

  if (leadRowsError) {
    const error = new Error(`Lead reminder query failed: ${leadRowsError.message}`);
    await reportError("visit-emails", error);
    errors.push(error.message);
  }

  for (const lead of (leadRows ?? []) as LeadReminderRow[]) {
    if (!lead.email || !lead.site_visit_date) {
      reminders.skipped++;
      continue;
    }
    const visitDatetime = lead.site_visit_date;

    // Per-lead try/catch: ensureBriefToken() can now throw on a failed
    // write (see its own comment — it used to silently hand back an
    // unpersisted token) rather than sending a dead {{brief_link}}.
    // Without this guard, one lead's DB hiccup would throw out of the
    // loop and skip every remaining lead's reminder for the day.
    try {
      // {{brief_link}} — mint the token lazily on this, its first real
      // need (docs/RESLU-lead-flow-brief.md build task 1 + this round's
      // own BUILD instructions: "Token: generated lazily when the
      // reminder email builds {{brief_link}}"). ensureBriefToken() is a
      // no-op read when the lead already has one (every reminder after
      // the first for this lead).
      const briefToken = await ensureBriefToken(supabase, lead.id, lead.brief_token);
      const briefLink = briefUrlFor(briefToken);

      // {{calendar_link}} + invite.ics — current visit_ics_sequence, NO
      // increment (a reminder never changes the visit's date/time; only
      // a reschedule via PATCH /api/leads/[id] increments the sequence —
      // see that route's own doc comment).
      const { calendarLink, icsAttachment } = buildLeadVisitCalendarAssets(
        lead.id,
        visitDatetime,
        lead.visit_ics_sequence ?? 0,
        DEFAULT_PHILLIP_PHONE
      );

      const result = await sendOrQueue(supabase, {
        recordType: "lead",
        recordId: lead.id,
        template: "visit-reminder",
        to: [lead.email],
        // No longer says "tomorrow" — the reminder now fires ~2 days out
        // (see this route's own header comment), so that word would be
        // inaccurate for this record type specifically.
        subject: `Your site visit — ${formatVisitDate(visitDatetime)}`,
        mergeData: {
          first_name: lead.first_name,
          last_name: leadLastName(lead.surname_project),
          visit_date: formatVisitDate(visitDatetime),
          visit_time: formatVisitTime(visitDatetime),
          suburb: suburbFrom(lead.site_visit_location || lead.location),
          calendar_link: calendarLink,
          brief_link: briefLink,
        },
        visitDatetime,
        attachments: [icsAttachment],
        now,
      });
      if (result.action === "sent") reminders.sent++;
      else if (result.action === "queued") reminders.queued++;
      else reminders.skipped++;
    } catch (err) {
      await reportError("visit-emails", err);
      errors.push(err instanceof Error ? err.message : `Lead reminder failed for ${lead.id}`);
      reminders.skipped++;
    }
  }

  // ---- Client events (UNCHANGED — still "tomorrow"; see header comment) ----
  const { data: eventRows, error: eventRowsError } = await supabase
    .from("client_events")
    .select("id,project_id,starts_at,location")
    .is("deleted_at", null)
    .gte("starts_at", start.toISOString())
    .lt("starts_at", end.toISOString());

  if (eventRowsError) {
    const error = new Error(`Client-event reminder query failed: ${eventRowsError.message}`);
    await reportError("visit-emails", error);
    errors.push(error.message);
  }

  const typedEvents = (eventRows ?? []) as ClientEventReminderRow[];
  const projectIds = [...new Set(typedEvents.map((e) => e.project_id))];
  const { data: projectRows, error: projectRowsError } = projectIds.length
    ? await supabase
        .from("projects")
        .select("id,name,client_name,client_email,client_secondary_email")
        .in("id", projectIds)
    : { data: [] as ProjectRow[], error: null };
  if (projectRowsError) {
    const error = new Error(`Reminder project query failed: ${projectRowsError.message}`);
    await reportError("visit-emails", error);
    errors.push(error.message);
  }
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
    try {
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
    } catch (err) {
      await reportError("visit-emails", err);
      errors.push(err instanceof Error ? err.message : `Client-event reminder failed for ${event.id}`);
      reminders.skipped++;
    }
  }

  const degraded =
    errors.length > 0 || flushed.failed > 0 || proposalsFlushed.failed > 0;
  const body: VisitEmailsRunResult = {
    ok: !degraded,
    status: degraded ? "degraded" : "succeeded",
    flushed,
    reminders,
    proposalsFlushed,
    errors,
  };
  await recordJobRun(supabase, {
    jobKey: "visit_emails",
    status: body.status,
    startedAt,
    summary: { flushed, reminders, proposalsFlushed },
    error: errors.join(" | ") || null,
  });
  return NextResponse.json(body);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
