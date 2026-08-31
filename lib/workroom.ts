import type { AgentTask } from "@/types/conversations";
import type { WorkroomRoutine, WorkroomTask } from "@/types/workroom";

export type WorkroomView = "approvals" | "recovery" | "outstanding" | "recurring" | "history";
export type RecoveryFilter = "all" | "needs-diagnosis" | "approved-work" | "retryable";
export type HistoryFilter = "all" | "completed" | "cancelled";

export const WORKROOM_VIEWS: WorkroomView[] = ["approvals", "recovery", "outstanding", "recurring", "history"];

export function isWorkroomView(value: string | null | undefined): value is WorkroomView {
  return Boolean(value && WORKROOM_VIEWS.includes(value as WorkroomView));
}

export function workroomView(task: AgentTask): Exclude<WorkroomView, "recurring"> {
  if (task.status === "awaiting_approval") return "approvals";
  if (task.status === "failed") return "recovery";
  if (task.status === "completed" || task.status === "cancelled") return "history";
  return "outstanding";
}

function timestamp(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function workroomTaskActivityAt(task: WorkroomTask) {
  return Math.max(
    timestamp(task.updated_at),
    timestamp(task.progress_updated_at),
    timestamp(task.completed_at),
    ...task.events.map((event) => timestamp(event.created_at)),
    ...task.artifacts.map((artifact) => timestamp(artifact.updated_at)),
  );
}

export function recoveryKind(task: WorkroomTask): Exclude<RecoveryFilter, "all" | "retryable"> | "manual-review" {
  const text = [task.error, task.progress_label, task.result_summary].filter(Boolean).join(" ").toLowerCase();
  const generic = !text.trim() || /openclaw (run |gateway )?failed|codex stopped|finishing (the )?response|gateway connection failed/.test(text);
  const approved = task.approval_state !== "none" || /\bapprov(ed|al)\b/.test([task.title, task.objective, task.result_summary].filter(Boolean).join(" ").toLowerCase());
  if (approved) return "approved-work";
  if (generic) return "needs-diagnosis";
  return "manual-review";
}

export function recoveryGroupLabel(task: WorkroomTask) {
  const kind = recoveryKind(task);
  if (kind === "approved-work") return "Approved work to verify";
  if (kind === "needs-diagnosis") return "Needs a clearer diagnosis";
  return "Review and recover";
}

export function recoveryGuidance(task: WorkroomTask) {
  const kind = recoveryKind(task);
  if (kind === "approved-work") return {
    whatHappened: task.error?.trim() || "The assignment stopped after approval was involved, before a verified completion was recorded.",
    nextStep: "Check the destination and conversation first so the approved action is not repeated, then retry only if the intended result is still missing.",
  };
  if (kind === "needs-diagnosis") return {
    whatHappened: "The agent stopped before it recorded a specific, verified cause. The current failure message is not enough to retry safely on its own.",
    nextStep: "Open the conversation and inspect the last completed step. Confirm the external state, then retry only when duplicate work has been ruled out.",
  };
  return {
    whatHappened: task.error?.trim() || "The assignment stopped before completion.",
    nextStep: "Review the evidence and current destination state before choosing Retry safely.",
  };
}

export function workroomTaskMatchesSearch(task: WorkroomTask, query: string) {
  const clean = query.trim().toLowerCase();
  if (!clean) return true;
  return [task.title, task.objective, task.error, task.result_summary, task.progress_label, task.conversation.title, task.owner_agent?.display_name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(clean);
}

export function filterWorkroomTasks(
  tasks: WorkroomTask[],
  view: WorkroomView,
  agentId = "all",
  query = "",
  filter: RecoveryFilter | HistoryFilter = "all",
  selfId = "",
) {
  if (view === "recurring") return [];
  return tasks
    .filter((task) => workroomView(task) === view && (agentId === "all" || task.owner_agent_id === agentId))
    .filter((task) => workroomTaskMatchesSearch(task, query))
    .filter((task) => {
      if (view === "recovery") {
        if (filter === "needs-diagnosis" || filter === "approved-work") return recoveryKind(task) === filter;
        if (filter === "retryable") return task.requested_by === selfId && task.retry_count < 3;
      }
      if (view === "history" && (filter === "completed" || filter === "cancelled")) return task.status === filter;
      return true;
    })
    .sort((left, right) => {
      if (view === "recovery") {
        const priority = { "approved-work": 3, "needs-diagnosis": 2, "manual-review": 1 };
        const difference = priority[recoveryKind(right)] - priority[recoveryKind(left)];
        if (difference) return difference;
      }
      return workroomTaskActivityAt(right) - workroomTaskActivityAt(left);
    });
}

export function workroomCounts(tasks: AgentTask[]) {
  return tasks.reduce((counts, task) => {
    counts[workroomView(task)] += 1;
    return counts;
  }, { approvals: 0, recovery: 0, outstanding: 0, history: 0 });
}

export function cronCadence(schedule: string) {
  if (/^\*\/\d+ /.test(schedule)) return `Every ${schedule.slice(2).split(" ")[0]} minutes`;
  if (/^\d+-59\/\d+ /.test(schedule)) return `Every ${schedule.split("/")[1].split(" ")[0]} minutes`;
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return "Recurring";
  if (fields[4] !== "*") return "Weekly";
  if (fields[2] === "*" && fields[3] === "*") return fields[1] === "*" ? "Hourly" : "Daily";
  return "Recurring";
}

function cronFieldMatches(field: string, value: number) {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isFinite(step) || step < 1) return false;
    if (range === "*") return value % step === 0;
    const [startText, endText] = range.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end && (value - start) % step === 0;
  });
}

export function nextCronRun(schedule: string, from = new Date()) {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = 8 * 24 * 60;
  for (let minute = 0; minute < limit; minute += 1) {
    if (
      cronFieldMatches(fields[0], candidate.getUTCMinutes()) &&
      cronFieldMatches(fields[1], candidate.getUTCHours()) &&
      cronFieldMatches(fields[2], candidate.getUTCDate()) &&
      cronFieldMatches(fields[3], candidate.getUTCMonth() + 1) &&
      cronFieldMatches(fields[4], candidate.getUTCDay())
    ) return candidate.toISOString();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

const ROUTINE_META: Record<string, { label: string; owner: string; description: string }> = {
  "/api/digest/flush": { label: "Message digest delivery", owner: "System", description: "Collects queued notification items and sends each person their due RESLU digest." },
  "/api/trade-reminders": { label: "Trade reminders", owner: "Aria", description: "Checks upcoming site visits and sends the due reminder to each confirmed trade." },
  "/api/client-events/remind": { label: "Client event reminders", owner: "Aria", description: "Finds upcoming client events and prepares the reminders that are due." },
  "/api/leads/queue-sync": { label: "Lead queue sync", owner: "Marco", description: "Reviews lead follow-up dates and keeps Marco's due lead work in sync." },
  "/api/second-brain/reindex": { label: "Second Brain reindex", owner: "System", description: "Refreshes the searchable index used by agents to retrieve RESLU knowledge." },
  "/api/second-brain/triage": { label: "Second Brain triage", owner: "System", description: "Finds newly captured knowledge and decides what needs extraction or review." },
  "/api/second-brain/extract": { label: "Second Brain extraction", owner: "System", description: "Extracts structured facts and useful evidence from triaged source material." },
  "/api/second-brain/match": { label: "Second Brain matching", owner: "System", description: "Matches extracted evidence to existing people, projects and knowledge records." },
  "/api/second-brain/propose": { label: "Second Brain proposals", owner: "System", description: "Prepares governed knowledge updates for review instead of silently changing records." },
  "/api/brief/generate": { label: "Daily brief", owner: "Aria", description: "Builds the daily operational brief from due work, appointments and agent activity." },
  "/api/visit-emails/run": { label: "Visit email follow-up", owner: "Aria", description: "Checks booked visits and sends the correct confirmation or follow-up email when due." },
  "/api/aria-queue/routines/daily_review": { label: "Daily work review", owner: "Aria", description: "Reviews Aria's outstanding work and creates a concise daily follow-up assignment." },
  "/api/aria-queue/routines/weekly_review": { label: "Weekly work review", owner: "Aria", description: "Runs Aria's broader weekly review of unresolved work and recurring responsibilities." },
  "/api/health/check": { label: "System health check", owner: "System", description: "Checks channels, scheduled jobs and runtime health, then raises deduplicated incidents." },
  "/api/meeting-retention/purge": { label: "Meeting retention cleanup", owner: "System", description: "Removes meeting recordings and derived data after the configured retention window." },
  "/api/stuart/review": { label: "Daily accounts review", owner: "Stuart", description: "Reviews finance exceptions and due accounting work for Stuart's daily queue." },
  "/api/stuart/accounts-invoices": { label: "Accounts and invoice review", owner: "Stuart", description: "Checks incoming accounts and invoices for work that needs reconciliation or attention." },
  "/api/quote-requests/reconcile": { label: "Quote request reconciliation", owner: "Stuart", description: "Matches supplier quote responses back to their requests and flags missing information." },
};

export function workroomRoutines(crons: Array<{ path: string; schedule: string }>, now = new Date()): WorkroomRoutine[] {
  return crons.map((cron) => {
    const meta = ROUTINE_META[cron.path] ?? {
      label: cron.path.split("/").filter(Boolean).slice(1).join(" · ").replaceAll("-", " "),
      owner: "System",
      description: "Runs this RESLU system routine automatically on its configured schedule.",
    };
    return {
      id: cron.path,
      label: meta.label,
      owner: meta.owner,
      description: meta.description,
      schedule: cron.schedule,
      cadence: cronCadence(cron.schedule),
      next_run_at: nextCronRun(cron.schedule, now),
    };
  });
}
