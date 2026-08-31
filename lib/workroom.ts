import type { AgentTask } from "@/types/conversations";
import type { WorkroomRoutine, WorkroomTask } from "@/types/workroom";

export type WorkroomView = "attention" | "outstanding" | "recurring" | "history";

export function workroomView(task: AgentTask): Exclude<WorkroomView, "recurring"> {
  if (task.status === "awaiting_approval" || task.status === "failed") return "attention";
  if (task.status === "completed" || task.status === "cancelled") return "history";
  return "outstanding";
}

export function filterWorkroomTasks(tasks: WorkroomTask[], view: WorkroomView, agentId = "all") {
  if (view === "recurring") return [];
  return tasks.filter((task) => workroomView(task) === view && (agentId === "all" || task.owner_agent_id === agentId));
}

export function workroomCounts(tasks: AgentTask[]) {
  return tasks.reduce((counts, task) => {
    counts[workroomView(task)] += 1;
    return counts;
  }, { attention: 0, outstanding: 0, history: 0 });
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

const ROUTINE_META: Record<string, { label: string; owner: string }> = {
  "/api/aria-queue/routines/daily_review": { label: "Daily work review", owner: "Aria" },
  "/api/aria-queue/routines/weekly_review": { label: "Weekly work review", owner: "Aria" },
  "/api/stuart/review": { label: "Daily accounts review", owner: "Stuart" },
  "/api/stuart/accounts-invoices": { label: "Accounts and invoice review", owner: "Stuart" },
  "/api/brief/generate": { label: "Daily brief", owner: "Aria" },
  "/api/visit-emails/run": { label: "Visit email follow-up", owner: "Aria" },
  "/api/trade-reminders": { label: "Trade reminders", owner: "Aria" },
  "/api/client-events/remind": { label: "Client event reminders", owner: "Aria" },
  "/api/leads/queue-sync": { label: "Lead queue sync", owner: "Marco" },
  "/api/quote-requests/reconcile": { label: "Quote request reconciliation", owner: "Stuart" },
};

export function workroomRoutines(crons: Array<{ path: string; schedule: string }>): WorkroomRoutine[] {
  return crons.map((cron) => {
    const meta = ROUTINE_META[cron.path] ?? {
      label: cron.path.split("/").filter(Boolean).slice(1).join(" · ").replaceAll("-", " "),
      owner: "System",
    };
    return {
      id: cron.path,
      label: meta.label,
      owner: meta.owner,
      schedule: cron.schedule,
      cadence: cronCadence(cron.schedule),
    };
  });
}
