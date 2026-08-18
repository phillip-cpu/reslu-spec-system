import { createServiceRoleClient } from "@/lib/supabase/server";
import { cronHealthLevel } from "@/lib/health-status";
import {
  conversationCapabilityUnavailable,
  conversationTransportHasIncident,
  conversationTransportLevel,
  summarizeConversationVoiceHealth,
} from "@/lib/conversation-health";
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
const CONVERSATION_FAILURE_WINDOW_HOURS = 24;
const STUCK_CONVERSATION_JOB_MINUTES = 15;
const STUCK_AGENT_TASK_MINUTES = 30;
const STALE_ACTIVE_CALL_HOURS = 4;
const VOICE_HEALTH_WINDOW_DAYS = 7;

const REQUIRED_CONVERSATION_CAPABILITIES = [
  {
    key: "message_forwarding",
    rpc: "forward_conversation_message",
    args: {
      p_source_conversation_id: null,
      p_source_message_id: null,
      p_destination_conversation_ids: null,
      p_client_forward_id: null,
    },
  },
  {
    key: "group_management",
    rpc: "rename_conversation_group",
    args: { p_conversation_id: null, p_title: null, p_client_action_id: null },
  },
] as const;

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

async function conversationTransportHealth(supabase: ServiceClient) {
  const now = Date.now();
  const failureCutoff = new Date(now - CONVERSATION_FAILURE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const stuckJobCutoff = new Date(now - STUCK_CONVERSATION_JOB_MINUTES * 60 * 1000).toISOString();
  const stuckTaskCutoff = new Date(now - STUCK_AGENT_TASK_MINUTES * 60 * 1000).toISOString();
  const staleCallCutoff = new Date(now - STALE_ACTIVE_CALL_HOURS * 60 * 60 * 1000).toISOString();
  const voiceCutoff = new Date(now - VOICE_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [results, capabilityProbes] = await Promise.all([Promise.all([
    supabase.from("agent_conversation_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("agent_conversation_jobs").select("created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("agent_conversation_jobs").select("id", { count: "exact", head: true }).eq("status", "processing").lt("claimed_at", stuckJobCutoff),
    supabase.from("agent_conversation_jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("completed_at", failureCutoff),
    supabase.from("agent_tasks").select("id", { count: "exact", head: true }).eq("status", "queued"),
    supabase.from("agent_tasks").select("claimed_at,updated_at,progress_updated_at").eq("status", "running"),
    supabase.from("agent_tasks").select("id", { count: "exact", head: true }).eq("status", "failed").gte("completed_at", failureCutoff),
    supabase.from("conversation_calls").select("id", { count: "exact", head: true }).eq("status", "active").lt("started_at", staleCallCutoff),
    supabase.from("conversation_calls").select("realtime_voice_latency:metadata->realtime_voice_latency").gte("started_at", voiceCutoff).order("started_at", { ascending: false }).limit(50),
  ]), Promise.all(REQUIRED_CONVERSATION_CAPABILITIES.map(async (capability) => {
    const { error } = await supabase.rpc(capability.rpc, capability.args);
    if (!error) return { key: capability.key, unavailable: false, queryError: false };
    if (conversationCapabilityUnavailable(error)) {
      return { key: capability.key, unavailable: true, queryError: false };
    }
    // The deliberately invalid, content-free probe reaches an installed RPC's
    // own argument/auth guard and normally returns P0001. Any other provider or
    // transport failure is a health-read error rather than evidence of absence.
    return { key: capability.key, unavailable: false, queryError: error.code !== "P0001" };
  }))]);
  const [pending, oldestPending, stuckJobs, failedJobs, queuedTasks, runningTasks, failedTasks, staleCalls, voiceCalls] = results;
  const oldestCreatedAt = oldestPending.data && typeof oldestPending.data.created_at === "string"
    ? Date.parse(oldestPending.data.created_at)
    : Number.NaN;
  const voice = summarizeConversationVoiceHealth(voiceCalls.data ?? []);
  const runningTasksStuck = (runningTasks.data ?? []).filter((task) => {
    const freshestAt = task.progress_updated_at ?? task.updated_at ?? task.claimed_at;
    const freshestMs = typeof freshestAt === "string" ? Date.parse(freshestAt) : Number.NaN;
    return Number.isFinite(freshestMs) && freshestMs < Date.parse(stuckTaskCutoff);
  }).length;
  const core = {
    query_errors: results.filter((result) => result.error).length
      + capabilityProbes.filter((probe) => probe.queryError).length,
    unavailable_capabilities: capabilityProbes.filter((probe) => probe.unavailable).map((probe) => probe.key),
    pending_jobs: pending.count ?? 0,
    oldest_pending_job_ms: Number.isFinite(oldestCreatedAt) ? Math.max(0, now - oldestCreatedAt) : null,
    processing_jobs_stuck: stuckJobs.count ?? 0,
    failed_jobs_24h: failedJobs.count ?? 0,
    queued_tasks: queuedTasks.count ?? 0,
    running_tasks_stuck: runningTasksStuck,
    failed_tasks_24h: failedTasks.count ?? 0,
    active_calls_stale: staleCalls.count ?? 0,
    ...voice,
  };
  return {
    ...core,
    operational_incident: conversationTransportHasIncident(core),
    level: conversationTransportLevel(core),
  };
}

export async function computeSpecHealth(supabase: ServiceClient): Promise<SpecHealthSummary> {
  const [crons, failedEmailSends7d, stuckAriaQueue, needsAriaBacklog, conversationTransport] = await Promise.all([
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
    conversationTransportHealth(supabase),
  ]);

  return {
    crons,
    failed_email_sends_7d: failedEmailSends7d,
    aria_queue_stuck: stuckAriaQueue,
    needs_aria_backlog: needsAriaBacklog,
    conversation_transport: conversationTransport,
  };
}

/** Minutes since an ISO timestamp — Infinity for null (never happened). */
export function minutesSince(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60);
}

/** BUILD-SPEC.md item 3(c) — "mini silent >15min" is the actual incident threshold (distinct from the Health page pill's earlier 7.5min amber warning — see lib/health-status.ts's heartbeatAgeLevel). */
export const MINI_SILENCE_INCIDENT_MINUTES = 15;

/**
 * Item 5 — channel monitor silence. This measures the age of the mini's
 * channel-status report (`health_channels.updated_at`), not customer message
 * traffic. A healthy channel can legitimately receive no inbound or outbound
 * messages for days; quiet traffic is not an outage.
 */
export const CHANNEL_SILENCE_INCIDENT_HOURS = 24;
export const CONVERSATION_BRIDGE_SILENCE_INCIDENT_MINUTES = 5;

export function channelReportSilenceThresholdHours(channel: string): number {
  return channel === "reslu_conversation_bridge"
    ? CONVERSATION_BRIDGE_SILENCE_INCIDENT_MINUTES / 60
    : CHANNEL_SILENCE_INCIDENT_HOURS;
}

export function channelReportIsSilent(
  updatedAt: string | null,
  nowMs = Date.now(),
  thresholdHours = CHANNEL_SILENCE_INCIDENT_HOURS
): boolean {
  if (!updatedAt) return true;
  const ageHours = (nowMs - new Date(updatedAt).getTime()) / (1000 * 60 * 60);
  return ageHours > thresholdHours;
}
