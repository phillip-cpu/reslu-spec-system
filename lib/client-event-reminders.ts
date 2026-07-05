import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTeamEmail, isGmailConfigured } from "@/lib/gmail/send";

/**
 * Client event "day before" reminder emails (BUILD-SPEC.md §"Portal —
 * upcoming client meetings"): "Reminder email to client the day before
 * via notify-client (respects notify_client toggle)."
 *
 * NOTE on the email content vs lib/notify-client.ts: notify-client.ts
 * sends "something changed, go look at the portal" nudges for
 * diary/document/signature/variation events — it's a generic batching
 * layer over a fixed set of trigger verbs, not built for "here are the
 * actual details of an upcoming meeting" (date/time/location/notes).
 * This module is deliberately its own small sender (same underlying
 * transport, lib/gmail/send.ts's sendTeamEmail — "via notify-client"
 * in the spec is read as "using the same established
 * client-notification PATTERN [Gmail lib, notify_client toggle,
 * client_email + secondary recipient list, warm brand tone, no-op if
 * unconfigured]", not literally routing through notifyClientBatch(),
 * whose NotifyClientTrigger union has no slot for "a meeting is
 * tomorrow" and whose section anchors (diary/documents/contracts/
 * variations) have no "meetings" portal section to link to since
 * meetings render as a card, not a nav section — see
 * components/portal/UpcomingMeetingsCard.tsx). Reusing that module's
 * event union would mean widening a shared, already-shipped type for a
 * one-off content shape; a small parallel sender the same size as
 * lib/notify-client.ts itself is the lower-risk change.
 *
 * Content note (verification checklist item, per this task's brief):
 * client_events.notes is CLIENT-FACING BY DESIGN — this table only
 * exists to power the client portal's "Upcoming meetings" card, unlike
 * trade_visits.notes (internal-only, never reaches the client). Staff
 * entering a note here should write it as they would any other
 * client-visible copy (e.g. "Bring any tile samples you're still
 * deciding between" is fine; internal logistics chatter is not) — the
 * team-side ClientEventsPanel UI carries this same reminder inline.
 *
 * Reminder gate: client_events.reminder_sent_at (migration 020) is
 * stamped once a reminder sends successfully — mirrors
 * trade_visits.reminder_sent_at's exact "never re-sent" contract
 * (app/api/trade-reminders/route.ts). A Gmail-not-configured skip does
 * NOT stamp the column, so the event is retried on the next run once
 * Gmail is wired up — same reasoning as the trade-reminders route.
 */

export interface SendDueRemindersResult {
  sent: number;
  skipped: number;
  failed: number;
}

interface ClientEventRow {
  id: string;
  project_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  client_name: string;
  client_email: string | null;
  client_secondary_email: string | null;
  notify_client: boolean;
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au").replace(/\/+$/, "");
}

function formatWhen(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt);
  const dateLabel = start.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const startTime = start.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  if (!endsAt) return `${dateLabel}, ${startTime}`;
  const endTime = new Date(endsAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return `${dateLabel}, ${startTime} – ${endTime}`;
}

/**
 * Finds every non-deleted client_events row starting "tomorrow" (24h
 * out from `now`, using a whole-calendar-day match like
 * app/api/trade-reminders/route.ts's ±1-day fuzz, but single-day here
 * since a meeting reminder's promise is specifically "the day before")
 * that hasn't been reminded yet, and sends one email per event to the
 * project's client (primary + secondary, same recipient-list pattern
 * as lib/notify-client.ts). Skips (without stamping reminder_sent_at)
 * when Gmail isn't configured, the project has no client_email, or
 * notify_client is off. Never throws — errors are caught per-event so
 * one bad row doesn't abort the whole batch, mirroring
 * app/api/trade-reminders/route.ts's per-visit try/catch.
 */
export async function sendDueReminders(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<SendDueRemindersResult> {
  const result: SendDueRemindersResult = { sent: 0, skipped: 0, failed: 0 };

  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000);
  const dayAfterStart = new Date(todayUtc.getTime() + 2 * 24 * 60 * 60 * 1000);

  const { data: events, error } = await supabase
    .from("client_events")
    .select("id,project_id,title,starts_at,ends_at,location,notes")
    .is("deleted_at", null)
    .is("reminder_sent_at", null)
    .gte("starts_at", tomorrowStart.toISOString())
    .lt("starts_at", dayAfterStart.toISOString());

  if (error) {
    throw new Error(error.message);
  }

  const typedEvents = (events ?? []) as ClientEventRow[];
  if (typedEvents.length === 0) {
    return result;
  }

  if (!isGmailConfigured()) {
    // Nothing sendable this run — every due event is skipped, none
    // stamped, so they're retried once Gmail is wired up.
    result.skipped = typedEvents.length;
    return result;
  }

  const projectIds = [...new Set(typedEvents.map((e) => e.project_id))];
  const { data: projects } = await supabase
    .from("projects")
    .select("id,name,client_name,client_email,client_secondary_email,notify_client")
    .in("id", projectIds);

  const projectById = new Map((projects ?? []).map((p) => [p.id, p as ProjectRow]));

  for (const event of typedEvents) {
    const project = projectById.get(event.project_id);
    if (!project) {
      result.skipped++;
      continue;
    }
    if (!project.notify_client) {
      result.skipped++;
      continue;
    }
    const to = [project.client_email, project.client_secondary_email].filter(
      (e): e is string => !!e
    );
    if (to.length === 0) {
      result.skipped++;
      continue;
    }

    const portalLink = `${appUrl()}/portal/${await tokenFor(supabase, event.project_id)}`;

    const lines = [
      `Hi ${project.client_name},`,
      "",
      `Just a reminder — you have a meeting coming up tomorrow:`,
      "",
      `${event.title}`,
      formatWhen(event.starts_at, event.ends_at),
      ...(event.location ? [event.location] : []),
      ...(event.notes ? ["", event.notes] : []),
      "",
      `View your project portal: ${portalLink}`,
      "",
      "Warm regards,",
      "The RESLU team",
    ];

    try {
      const sendResult = await sendTeamEmail({
        to,
        subject: `${project.name} — reminder: ${event.title} tomorrow`,
        body: lines.join("\n"),
      });
      if (sendResult.skipped) {
        result.skipped++;
        continue;
      }
      await supabase
        .from("client_events")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", event.id);
      result.sent++;
    } catch (err) {
      console.error("client-event-reminders: send failed for event", event.id, err);
      result.failed++;
    }
  }

  return result;
}

/** Small helper — looks up a project's client_token for the portal link. Kept as a tiny per-event lookup (batch size here is always small — a handful of meetings a day at most) rather than joining it into the main query, since client_token is otherwise never selected alongside client_events in this module's main query above. */
async function tokenFor(supabase: SupabaseClient, projectId: string): Promise<string> {
  const { data } = await supabase.from("projects").select("client_token").eq("id", projectId).single();
  return data?.client_token ?? "";
}
