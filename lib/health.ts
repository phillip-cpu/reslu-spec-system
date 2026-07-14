import { createServiceRoleClient } from "@/lib/supabase/server";
import { cronHealthLevel } from "@/lib/health-status";
import type { SpecHealthSummary } from "@/types/health-push";

// ============================================================
// RESLU Spec System — Health + web push (r26)
// BUILD-SPEC.md item 4's "Spec card": monitored job executions, failed
// email sends, aria_queue stuck >24h, and the needs_aria backlog.
//
// STUDY FINDING (this round's own final report has the full write-up):
// A cron run is not the same as one of its optional side effects. In
// particular, visit-emails can complete successfully on a day when no
// message is due. Phase 2 records its run in system_job_runs so Health
// does not falsely report that valid no-op as "never ran". The older
// Daily Brief monitor remains derived from daily_brief_items until that
// route adopts the same execution log.
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

const MONITORED_CRONS: CronDef[] = [
  {
    key: "visit_emails",
    label: "Visit emails (confirmations/reminders)",
    expectedIntervalHours: 1,
  },
  {
    key: "brief_generate",
    label: "Daily Brief generation",
    expectedIntervalHours: 24,
  },
  {
    key: "aria_daily_review_enqueue",
    label: "Aria daily proactive review",
    expectedIntervalHours: 24,
  },
  {
    key: "aria_weekly_review_enqueue",
    label: "Aria weekly synthesis",
    expectedIntervalHours: 168,
  },
];

type JobRunStatus = "succeeded" | "degraded" | "failed";

interface CronExecution {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  status: JobRunStatus | null;
  error: string | null;
}

async function latestJobExecution(supabase: ServiceClient, jobKey: string): Promise<CronExecution> {
  const [{ data: latest }, { data: latestSuccess }] = await Promise.all([
    supabase
      .from("system_job_runs")
      .select("status,finished_at,error")
      .eq("job_key", jobKey)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("system_job_runs")
      .select("finished_at")
      .eq("job_key", jobKey)
      .eq("status", "succeeded")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    lastRunAt: (latest?.finished_at as string | undefined) ?? null,
    lastSuccessAt: (latestSuccess?.finished_at as string | undefined) ?? null,
    status: (latest?.status as JobRunStatus | undefined) ?? null,
    error: (latest?.error as string | undefined) ?? null,
  };
}

async function lastBriefGenerateSuccessAt(supabase: ServiceClient): Promise<string | null> {
  const { data } = await supabase
    .from("daily_brief_items")
    .select("created_at")
    .eq("created_by_kind", "system")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.created_at as string | undefined) ?? null;
}

async function cronExecution(supabase: ServiceClient, key: string): Promise<CronExecution> {
  if (key === "brief_generate") {
    const lastSuccessAt = await lastBriefGenerateSuccessAt(supabase);
    return {
      lastRunAt: lastSuccessAt,
      lastSuccessAt,
      status: lastSuccessAt ? "succeeded" : null,
      error: null,
    };
  }
  return latestJobExecution(supabase, key);
}

function cronExecutionLevel(execution: CronExecution, expectedIntervalHours: number) {
  if (execution.status === "failed") return "red" as const;
  if (execution.status === "degraded") return "amber" as const;
  return cronHealthLevel(execution.lastRunAt, expectedIntervalHours);
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
      MONITORED_CRONS.map(async (def) => {
        const execution = await cronExecution(supabase, def.key);
        return {
          key: def.key,
          label: def.label,
          last_run_at: execution.lastRunAt,
          last_success_at: execution.lastSuccessAt,
          last_status: execution.status,
          last_error: execution.error,
          level: cronExecutionLevel(execution, def.expectedIntervalHours),
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
