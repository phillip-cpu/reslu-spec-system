import { createServiceRoleClient } from "@/lib/supabase/server";
import { cronHealthLevel } from "@/lib/health-status";
import type { SpecHealthSummary } from "@/types/health-push";

// ============================================================
// RESLU Spec System — Health + web push (r26)
// BUILD-SPEC.md item 4's "Spec card": "each cron's last success from
// email_sends/daily brief tables where derivable, failed email sends
// count, aria_queue stuck >24h, needs_aria backlog count."
//
// STUDY FINDING (this round's own final report has the full write-up):
// email_sends only carries record_type in ('lead','client_event',
// 'client_invoice','trade_booking_request','proposal') — NOT every
// cron in vercel.json writes to it (the Second Brain triage/extract/
// match/propose crons and /api/digest/flush write nowhere this app can
// read a "last success" from without touching a protected/read-only
// file). "Where derivable" is read literally: only the crons whose
// last-success timestamp is actually reconstructable from email_sends
// or daily_brief_items are covered below; the rest are a documented gap
// (see this round's final report), not silently faked with an
// unrelated timestamp.
// ============================================================

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

const STUCK_ARIA_QUEUE_HOURS = 24;
const FAILED_SENDS_WINDOW_DAYS = 7;

interface CronDef {
  key: string;
  label: string;
  /** How this cron's own vercel.json schedule cadence maps to an expected interval, for cronHealthLevel's tolerance. */
  expectedIntervalHours: number;
}

// Only the crons genuinely derivable from email_sends/daily_brief_items
// — see this file's header comment.
const DERIVABLE_CRONS: CronDef[] = [
  {
    key: "visit_emails",
    label: "Visit emails (confirmations/reminders)",
    expectedIntervalHours: 24,
  },
  {
    key: "brief_generate",
    label: "Daily Brief generation",
    expectedIntervalHours: 24,
  },
];

async function lastVisitEmailSuccessAt(supabase: ServiceClient): Promise<string | null> {
  // /api/visit-emails/run's own two templates — see lib/visit-emails.ts.
  // A 'sent' row is the cron's own definition of a successful send;
  // 'skipped'/'pending' rows don't count as a success.
  const { data } = await supabase
    .from("email_sends")
    .select("sent_at")
    .in("template", ["visit-confirmation", "visit-reminder"])
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sent_at as string | undefined) ?? null;
}

async function lastBriefGenerateSuccessAt(supabase: ServiceClient): Promise<string | null> {
  // GET /api/brief/generate?send=1 (the cron entry, vercel.json) is the
  // only writer of fresh daily_brief_items rows on its own daily
  // cadence — a system-created row's created_at is the best available
  // proxy for "the generator last ran successfully" without touching
  // that route itself (read-don't-edit, prior round).
  const { data } = await supabase
    .from("daily_brief_items")
    .select("created_at")
    .eq("created_by_kind", "system")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.created_at as string | undefined) ?? null;
}

async function cronLastSuccessAt(supabase: ServiceClient, key: string): Promise<string | null> {
  if (key === "visit_emails") return lastVisitEmailSuccessAt(supabase);
  if (key === "brief_generate") return lastBriefGenerateSuccessAt(supabase);
  return null;
}

/**
 * Failed sends in the last 7 days — email_sends rows logged
 * status='skipped' (the codebase's own "attempted, didn't go out"
 * status — see lib/visit-emails.ts/lib/resend.ts's sendResult.skipped
 * handling). 'pending' rows are queued-not-failed, deliberately
 * excluded.
 */
async function failedEmailSendsCount(supabase: ServiceClient): Promise<number> {
  const since = new Date(Date.now() - FAILED_SENDS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("email_sends")
    .select("id", { count: "exact", head: true })
    .eq("status", "skipped")
    .gte("created_at", since);
  return count ?? 0;
}

/**
 * aria_queue rows stuck >24h — status still 'pending' or 'picked_up'
 * (never resolved/failed) more than 24h after creation. Distinct from
 * migration 033's own 15-minute "picked_up visibility timeout" (which
 * re-exposes a row to get_aria_queue) — this is a much longer,
 * "something is actually wrong" threshold for the Health page, not a
 * queue-mechanics timeout.
 */
async function ariaQueueStuckCount(supabase: ServiceClient): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_ARIA_QUEUE_HOURS * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("aria_queue")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "picked_up"])
    .lt("created_at", cutoff);
  return count ?? 0;
}

/**
 * materials.price_refresh_status='needs_aria' backlog — the ONLY
 * "needs_aria" flag in this schema (migration 029, board cockpit
 * round) — see lib/board-cockpit.ts's own computeMaterialsNeedingAria
 * for the read-side precedent this count mirrors (a plain count here,
 * not the full row list that function returns, since the Health card
 * only needs a number).
 */
async function needsAriaBacklogCount(supabase: ServiceClient): Promise<number> {
  const { count } = await supabase
    .from("materials")
    .select("id", { count: "exact", head: true })
    .eq("price_refresh_status", "needs_aria")
    .is("deleted_at", null);
  return count ?? 0;
}

export async function computeSpecHealth(supabase: ServiceClient): Promise<SpecHealthSummary> {
  const [crons, failedEmailSends7d, stuckAriaQueue, needsAriaBacklog] = await Promise.all([
    Promise.all(
      DERIVABLE_CRONS.map(async (def) => {
        const lastSuccessAt = await cronLastSuccessAt(supabase, def.key);
        return {
          key: def.key,
          label: def.label,
          last_success_at: lastSuccessAt,
          level: cronHealthLevel(lastSuccessAt, def.expectedIntervalHours),
        };
      })
    ),
    failedEmailSendsCount(supabase),
    ariaQueueStuckCount(supabase),
    needsAriaBacklogCount(supabase),
  ]);

  return {
    crons,
    failed_email_sends_7d: failedEmailSends7d,
    aria_queue_stuck: stuckAriaQueue,
    needs_aria_backlog: needsAriaBacklog,
  };
}

/** Minutes since an ISO timestamp — Infinity for null (never happened). */
export function minutesSince(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60);
}

/** BUILD-SPEC.md item 3(c) — "mini silent >15min" is the actual incident threshold (distinct from the Health page pill's earlier 7.5min amber warning — see lib/health-status.ts's heartbeatAgeLevel). */
export const MINI_SILENCE_INCIDENT_MINUTES = 15;

/** Item 5 — channel silence: a channel that stops reporting inbound/outbound activity entirely (not just an explicit status='down' report) for this long is its own incident, complementary to the explicit-status push the channel-status route already fires on ingestion. */
export const CHANNEL_SILENCE_INCIDENT_HOURS = 24;
