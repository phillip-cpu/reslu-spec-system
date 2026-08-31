"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { agentAssignmentStatusLabel, assignmentLastUpdatedAt } from "@/lib/agent-operating-workspace";
import {
  filterWorkroomTasks,
  isWorkroomView,
  recoveryGroupLabel,
  recoveryGuidance,
  workroomCounts,
  type HistoryFilter,
  type RecoveryFilter,
  type WorkroomView,
} from "@/lib/workroom";
import {
  approvalActionLabel,
  artifactHasUsefulPreview,
  authorityTimingIssue,
  authorityRequest,
  inaccessibleAssets,
  policyForArtifact,
  reviewMediaIssue,
} from "@/lib/workroom-review";
import type { AgentTaskArtifact } from "@/types/conversations";
import type { WorkroomApprovalPolicy, WorkroomResponse, WorkroomTask } from "@/types/workroom";
import { ReviewArtifact } from "@/components/workroom/ReviewArtifact";

const VIEWS: Array<{ id: WorkroomView; label: string; quietLabel: string }> = [
  { id: "approvals", label: "Approvals", quietLabel: "Waiting on you" },
  { id: "recovery", label: "Recovery", quietLabel: "Failed work" },
  { id: "outstanding", label: "Active work", quietLabel: "Outstanding" },
  { id: "recurring", label: "Routines", quietLabel: "Recurring" },
  { id: "history", label: "History", quietLabel: "Completed" },
];

type TaskAction = "cancel" | "retry" | "dismiss" | "approve" | "reject" | "request_changes";
type WorkroomFilter = RecoveryFilter | HistoryFilter;

interface WorkroomWorkspaceProps {
  conversationId?: string | null;
  initialView?: string | null;
  initialTaskId?: string | null;
  initialAgentId?: string | null;
  initialQuery?: string | null;
  initialFilter?: string | null;
}

function dateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusColour(task: WorkroomTask) {
  if (task.status === "awaiting_approval") return "bg-[#b98517]";
  if (task.status === "failed") return "bg-[#b33a32]";
  if (task.status === "completed") return "bg-[#3f7958]";
  if (task.status === "cancelled") return "bg-charcoal/35";
  return "bg-[#274690]";
}

function noticeFor(action: TaskAction) {
  if (action === "approve") return "Decision saved. The agent can continue with the reviewed pack.";
  if (action === "request_changes") return "Feedback sent. The same assignment is back with the agent.";
  if (action === "reject") return "Review declined and the assignment stopped.";
  if (action === "retry") return "Recovery started after checking the current state.";
  if (action === "dismiss") return "Removed from your Workroom.";
  return "Assignment updated.";
}

function validFilter(value: string | null | undefined): WorkroomFilter {
  return ["needs-diagnosis", "approved-work", "retryable", "completed", "cancelled"].includes(value ?? "")
    ? value as WorkroomFilter
    : "all";
}

function localNextRun(value: string | null) {
  if (!value) return "Next run unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Next run unavailable";
  const day = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "Australia/Adelaide" }).format(date);
  const time = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Adelaide" }).format(date);
  return `Next run ${day} at ${time} Adelaide time`;
}

export function WorkroomWorkspace({
  conversationId = null,
  initialView = null,
  initialTaskId = null,
  initialAgentId = null,
  initialQuery = null,
  initialFilter = null,
}: WorkroomWorkspaceProps) {
  const [data, setData] = useState<WorkroomResponse | null>(null);
  const [view, setView] = useState<WorkroomView>(isWorkroomView(initialView) ? initialView : "approvals");
  const [agentId, setAgentId] = useState(initialAgentId?.trim() || "all");
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId?.trim() || null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(initialTaskId));
  const [query, setQuery] = useState(initialQuery ?? "");
  const [filter, setFilter] = useState<WorkroomFilter>(validFilter(initialFilter));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const actionLock = useRef<string | null>(null);
  const deferredQuery = useDeferredValue(query);

  const writeUrl = useCallback((next: { view?: WorkroomView; task?: string | null; agent?: string; query?: string; filter?: WorkroomFilter }, mode: "push" | "replace" = "replace") => {
    const params = new URLSearchParams(window.location.search);
    const nextView = next.view ?? view;
    const nextTask = next.task === undefined ? selectedId : next.task;
    const nextAgent = next.agent ?? agentId;
    const nextQuery = next.query ?? query;
    const nextFilter = next.filter ?? filter;
    if (nextView === "approvals") params.delete("view"); else params.set("view", nextView);
    if (nextTask) params.set("task", nextTask); else params.delete("task");
    if (nextAgent && nextAgent !== "all") params.set("agent", nextAgent); else params.delete("agent");
    if (nextQuery.trim()) params.set("q", nextQuery.trim()); else params.delete("q");
    if (nextFilter !== "all") params.set("filter", nextFilter); else params.delete("filter");
    const url = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
    window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
  }, [agentId, filter, query, selectedId, view]);

  useEffect(() => {
    function syncFromHistory() {
      const params = new URLSearchParams(window.location.search);
      const nextView = params.get("view");
      const nextTask = params.get("task");
      setView(isWorkroomView(nextView) ? nextView : "approvals");
      setSelectedId(nextTask);
      setMobileDetailOpen(Boolean(nextTask));
      setAgentId(params.get("agent") || "all");
      setQuery(params.get("q") || "");
      setFilter(validFilter(params.get("filter")));
    }
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/workroom", { cache: "no-store" });
      const body = await response.json() as WorkroomResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load the Workroom");
      setData(body);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the Workroom");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(load, 20_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [load]);

  const tasks = useMemo(() => {
    const all = data?.tasks ?? [];
    return conversationId ? all.filter((task) => task.conversation_id === conversationId) : all;
  }, [conversationId, data?.tasks]);
  const counts = useMemo(() => workroomCounts(tasks), [tasks]);
  const agents = useMemo(() => {
    const unique = new Map<string, NonNullable<WorkroomTask["owner_agent"]>>();
    for (const task of tasks) if (task.owner_agent) unique.set(task.owner_agent.id, task.owner_agent);
    return [...unique.values()];
  }, [tasks]);
  const filtered = useMemo(() => filterWorkroomTasks(tasks, view, agentId, deferredQuery, filter, data?.self_profile_id), [agentId, data?.self_profile_id, deferredQuery, filter, tasks, view]);
  const selected = selectedId ? filtered.find((task) => task.id === selectedId) ?? null : filtered[0] ?? null;
  const policies = data?.approval_policies ?? [];

  async function taskAction(task: WorkroomTask, action: TaskAction, artifactId?: string, note?: string) {
    const lockKey = `${task.id}:${artifactId ?? action}`;
    if (actionLock.current) return;
    actionLock.current = lockKey;
    setBusy(lockKey);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/conversations/${task.conversation_id}/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, artifact_id: artifactId, note }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update this assignment");
      setNotice(noticeFor(action));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this assignment");
    } finally {
      actionLock.current = null;
      setBusy(null);
    }
  }

  function selectTask(taskId: string) {
    setSelectedId(taskId);
    setMobileDetailOpen(true);
    setNotice(null);
    writeUrl({ task: taskId }, "push");
    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }));
    }
  }

  function selectView(nextView: WorkroomView) {
    setView(nextView);
    setSelectedId(null);
    setMobileDetailOpen(false);
    setFilter("all");
    setNotice(null);
    writeUrl({ view: nextView, task: null, filter: "all" }, "push");
  }

  function closeDetail() {
    setMobileDetailOpen(false);
    setSelectedId(null);
    writeUrl({ task: null }, "replace");
  }

  if (loading && !data) return <WorkroomSkeleton />;

  return (
    <div className="workroom-surface -mx-4 -my-5 min-h-[calc(100vh-92px)] px-4 py-5 md:-mx-8 md:-my-8 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1540px]">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-[#cfc5b6] pb-3 sm:mb-5 sm:flex-col sm:items-stretch sm:gap-4 sm:pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="hidden sm:block">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#76634f]">Studio work table</p>
            <p className="workroom-ink-note mt-2">What needs your eye, without the noise.</p>
          </div>
          <dl className="grid w-full grid-cols-4 gap-1 text-center text-[9px] uppercase tracking-[0.08em] text-charcoal/55 sm:flex sm:w-auto sm:flex-wrap sm:gap-x-7 sm:gap-y-3 sm:text-left sm:text-[12px] sm:normal-case sm:tracking-normal">
            <div className="bg-[#f5f1e8]/70 px-1 py-2 sm:bg-transparent sm:p-0"><dt className="block sm:inline">Approvals </dt><dd className="block text-[14px] font-semibold text-nearblack sm:inline sm:text-[12px]">{counts.approvals}</dd></div>
            <div className="bg-[#f5f1e8]/70 px-1 py-2 sm:bg-transparent sm:p-0"><dt className="block sm:inline">Recovery </dt><dd className="block text-[14px] font-semibold text-nearblack sm:inline sm:text-[12px]">{counts.recovery}</dd></div>
            <div className="bg-[#f5f1e8]/70 px-1 py-2 sm:bg-transparent sm:p-0"><dt className="block sm:inline">Active </dt><dd className="block text-[14px] font-semibold text-nearblack sm:inline sm:text-[12px]">{counts.outstanding}</dd></div>
            <div className="bg-[#f5f1e8]/70 px-1 py-2 sm:bg-transparent sm:p-0"><dt className="block sm:inline">Routines </dt><dd className="block text-[14px] font-semibold text-nearblack sm:inline sm:text-[12px]">{data?.routines.length ?? 0}</dd></div>
          </dl>
        </div>

        {error && <div role="alert" className="mb-4 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-[14px] text-red-900">{error}</div>}
        {notice && <div role="status" aria-live="polite" className="mb-4 border-l-2 border-[#3f7958] bg-[#edf5ef] px-4 py-3 text-[14px] text-[#254c36]">{notice}</div>}

        {conversationId && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-[#d4cbbd] bg-[#f5f1e8] px-4 py-3 text-[12px]"><span>Showing assignments from one conversation.</span><Link href="/workroom" className="font-semibold underline underline-offset-4">Show the whole Workroom</Link></div>}

        <section className="overflow-hidden border border-[#cfc5b6] bg-[#f5f1e8]/80">
          <div className="border-b border-[#cfc5b6] bg-[#eee7dc] p-3 md:px-4">
            <label className="block md:hidden">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">Workroom view</span>
              <select value={view} onChange={(event) => selectView(event.target.value as WorkroomView)} className="min-h-12 w-full border border-[#bfb3a1] bg-[#faf6ec] px-3 text-[15px] font-semibold text-nearblack">
                {VIEWS.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.id === "recurring" ? data?.routines.length ?? 0 : counts[item.id]}</option>)}
              </select>
            </label>
            <div className="hidden gap-1 overflow-x-auto md:flex" role="tablist" aria-label="Workroom views">
              {VIEWS.map((item) => {
                const count = item.id === "recurring" ? data?.routines.length ?? 0 : counts[item.id];
                return <button key={item.id} type="button" role="tab" aria-selected={view === item.id} onClick={() => selectView(item.id)} className={clsx("min-h-11 shrink-0 border-b-2 px-3 text-[12px] font-semibold transition-colors", view === item.id ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/55 hover:text-nearblack")}><span>{item.label}</span><span className="ml-2 font-normal text-charcoal/45">{count}</span><span className="sr-only"> · {item.quietLabel}</span></button>;
              })}
            </div>
          </div>

          <div className="grid gap-2 border-b border-[#cfc5b6] bg-[#f5f1e8] p-3 sm:grid-cols-[minmax(12rem,1fr)_auto_auto] md:px-4">
            {view !== "recurring" ? <label className="relative block"><span className="sr-only">Search this Workroom view</span><span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-charcoal/45">⌕</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSelectedId(null); setMobileDetailOpen(false); writeUrl({ query: event.target.value, task: null }, "replace"); }} placeholder={`Search ${VIEWS.find((item) => item.id === view)?.label.toLowerCase() ?? "work"}`} className="min-h-11 w-full border border-[#cfc5b6] bg-[#faf6ec] pl-9 pr-3 text-[14px] text-nearblack placeholder:text-charcoal/45" /></label> : <div className="hidden sm:block" />}
            {(view === "recovery" || view === "history") && <label className="grid grid-cols-[auto_1fr] items-center gap-2 text-[12px] text-charcoal/60"><span>Show</span><select value={filter} onChange={(event) => { const next = validFilter(event.target.value); setFilter(next); setSelectedId(null); setMobileDetailOpen(false); writeUrl({ filter: next, task: null }, "replace"); }} className="min-h-11 border border-[#cfc5b6] bg-[#faf6ec] px-3 text-[14px] text-nearblack">{view === "recovery" ? <><option value="all">All recovery</option><option value="approved-work">Approved work to verify</option><option value="needs-diagnosis">Needs diagnosis</option><option value="retryable">Ready to retry</option></> : <><option value="all">All history</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></>}</select></label>}
            <label className="grid grid-cols-[auto_1fr] items-center gap-2 text-[12px] text-charcoal/60"><span>Agent</span><select value={agentId} onChange={(event) => { setAgentId(event.target.value); setSelectedId(null); setMobileDetailOpen(false); writeUrl({ agent: event.target.value, task: null }, "replace"); }} className="min-h-11 border border-[#cfc5b6] bg-[#faf6ec] px-3 text-[14px] text-nearblack"><option value="all">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label>
          </div>

          {view === "recurring" ? <RoutineGrid routines={data?.routines ?? []} agents={agents} agentId={agentId} /> : (
            <div className="grid min-h-[620px] lg:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.55fr)] xl:grid-cols-[370px_minmax(0,1fr)]">
              <div className={clsx("border-[#cfc5b6] bg-[#f5f1e8] lg:block lg:border-r", mobileDetailOpen ? "hidden" : "block")}>
                {filtered.length ? <TaskQueue tasks={filtered} view={view} selectedId={selected?.id ?? null} onSelect={selectTask} /> : <Empty view={view} searching={Boolean(deferredQuery.trim()) || filter !== "all" || agentId !== "all"} />}
              </div>
              <div className={clsx("min-w-0 bg-[#ede8de] lg:block", mobileDetailOpen ? "block" : "hidden")}>
                {selected ? <TaskDetail task={selected} selfId={data?.self_profile_id ?? ""} policies={policies} busy={busy} onBack={closeDetail} onAction={taskAction} /> : <div className="flex min-h-[620px] items-center justify-center p-8 text-center text-[14px] text-charcoal/50">Choose an assignment to review its work, evidence and next action.</div>}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function WorkroomSkeleton() {
  return <div className="workroom-surface -mx-4 -my-5 min-h-[calc(100vh-92px)] px-4 py-5 md:-mx-8 md:-my-8 md:px-8 md:py-8"><div className="mx-auto max-w-[1540px] animate-pulse"><div className="h-16 border-b border-[#cfc5b6]" /><div className="mt-5 grid min-h-[620px] border border-[#cfc5b6] lg:grid-cols-[370px_1fr]"><div className="border-r border-[#cfc5b6] bg-[#f5f1e8]" /><div className="bg-[#ede8de] p-8"><div className="mx-auto h-96 max-w-3xl bg-[#faf6ec]" /></div></div></div></div>;
}

function TaskQueue({ tasks, view, selectedId, onSelect }: { tasks: WorkroomTask[]; view: WorkroomView; selectedId: string | null; onSelect: (taskId: string) => void }) {
  if (view !== "recovery") return <>{tasks.map((task) => <TaskQueueRow key={task.id} task={task} selected={selectedId === task.id} onSelect={() => onSelect(task.id)} />)}</>;
  const groups = new Map<string, WorkroomTask[]>();
  for (const task of tasks) {
    const label = recoveryGroupLabel(task);
    groups.set(label, [...(groups.get(label) ?? []), task]);
  }
  return <>{[...groups.entries()].map(([label, grouped]) => <section key={label} aria-label={label}><div className="sticky top-0 z-[1] flex items-center justify-between border-b border-[#ddd5c8] bg-[#eee7dc]/[0.96] px-5 py-2 backdrop-blur"><h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">{label}</h3><span className="text-[10px] text-charcoal/45">{grouped.length}</span></div>{grouped.map((task) => <TaskQueueRow key={task.id} task={task} selected={selectedId === task.id} onSelect={() => onSelect(task.id)} />)}</section>)}</>;
}

function TaskQueueRow({ task, selected, onSelect }: { task: WorkroomTask; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className={clsx("workroom-queue-row block min-h-[94px] w-full border-b border-[#ddd5c8] px-5 py-4 text-left", selected ? "bg-[#faf6ec]" : "hover:bg-[#f9f4ea]")}>
    <div className="flex items-center justify-between gap-3"><span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#76634f]">{task.owner_agent?.display_name ?? "Agent"}</span><span className="flex items-center gap-2 text-[11px] text-charcoal/60"><span className={clsx("h-2 w-2", statusColour(task))} aria-hidden />{agentAssignmentStatusLabel(task)}</span></div>
    <p className="mt-2 text-[15px] font-medium leading-snug text-nearblack">{task.title}</p>
    <p className="mt-2 truncate text-[11px] text-charcoal/50">{task.conversation.title} · {dateTime(assignmentLastUpdatedAt(task))}</p>
  </button>;
}

function Empty({ view, searching = false }: { view: WorkroomView; searching?: boolean }) {
  if (searching) return <div className="flex min-h-72 flex-col justify-center px-8 text-center"><p className="font-display text-[25px] text-nearblack">No matching work</p><p className="mt-2 text-[13px] leading-6 text-charcoal/55">Try a broader search or reset the filters above.</p></div>;
  const copy = view === "approvals" ? ["Nothing awaiting approval", "No agent is waiting on a decision from you."] : view === "recovery" ? ["Nothing needs recovery", "There is no failed work to inspect or retry."] : view === "outstanding" ? ["No active assignments", "The agents have no queued or running work."] : ["No history yet", "Completed work will settle here."];
  return <div className="flex min-h-72 flex-col justify-center px-8 text-center"><p className="font-display text-[25px] text-nearblack">{copy[0]}</p><p className="mt-2 text-[13px] leading-6 text-charcoal/55">{copy[1]}</p></div>;
}

function RoutineGrid({ routines, agents, agentId }: { routines: WorkroomResponse["routines"]; agents: Array<NonNullable<WorkroomTask["owner_agent"]>>; agentId: string }) {
  const visible = routines.filter((routine) => agentId === "all" || agents.find((agent) => agent.id === agentId)?.display_name === routine.owner);
  return <div className="grid items-start gap-px bg-[#d4cbbd] md:grid-cols-2 xl:grid-cols-3">{visible.map((routine, index) => <details key={routine.id} className="group bg-[#faf6ec] open:shadow-[inset_0_0_0_1px_#a08c72]"><summary className="min-h-56 cursor-pointer list-none p-5 marker:content-none sm:p-6"><div className="flex items-start justify-between gap-4"><span className="font-display text-[34px] leading-none text-[#c8b99f]">{String(index + 1).padStart(2, "0")}</span><span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">{routine.owner}<span aria-hidden className="text-[18px] font-normal transition-transform group-open:rotate-45">＋</span></span></div><h2 className="mt-5 font-display text-[25px] leading-tight text-nearblack">{routine.label}</h2><p className="mt-4 text-[14px] font-semibold text-charcoal/75">{routine.cadence}</p><p className="mt-2 text-[13px] leading-5 text-[#274690]">{localNextRun(routine.next_run_at)}</p><p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-charcoal/45 group-open:hidden">Open routine details</p></summary><div className="border-t border-[#d8d2c6] px-5 pb-6 pt-5 sm:px-6"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">What it does</p><p className="mt-2 text-[14px] leading-6 text-charcoal/75">{routine.description}</p><dl className="mt-5 space-y-3 border-t border-[#e2dacd] pt-4 text-[12px]"><div><dt className="font-semibold text-charcoal/50">Owner</dt><dd className="mt-1 text-nearblack">{routine.owner}</dd></div><div><dt className="font-semibold text-charcoal/50">Endpoint</dt><dd className="mt-1 break-all font-mono text-[11px] text-nearblack">{routine.id}</dd></div><div><dt className="font-semibold text-charcoal/50">Technical schedule</dt><dd className="mt-1 font-mono text-[11px] text-nearblack">{routine.schedule} · UTC</dd></div></dl></div></details>)}</div>;
}

function TaskDetail({ task, selfId, policies, busy, onBack, onAction }: { task: WorkroomTask; selfId: string; policies: WorkroomApprovalPolicy[]; busy: string | null; onBack: () => void; onAction: (task: WorkroomTask, action: TaskAction, artifactId?: string, note?: string) => void }) {
  const draftArtifacts = task.artifacts.filter((artifact) => artifact.status === "draft");
  const terminal = ["failed", "completed", "cancelled"].includes(task.status);
  const recovery = task.status === "failed" ? recoveryGuidance(task) : null;
  const actionsId = `task-actions-${task.id}`;
  return <article className="mx-auto max-w-[1040px] px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-9">
    <button type="button" onClick={onBack} className="mb-5 inline-flex min-h-11 items-center gap-2 text-[13px] font-semibold text-charcoal/65 lg:hidden"><span aria-hidden>←</span> Back to Workroom</button>
    <header className="border-b border-[#cfc5b6] pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.19em] text-[#76634f]">{task.owner_agent?.display_name ?? "Agent"} · {task.conversation.title}</p><h2 className="mt-3 max-w-3xl font-display text-[34px] font-light leading-[1.05] text-nearblack sm:text-[42px]">{task.title}</h2></div><span className="flex items-center gap-2 border border-[#cbbda7] bg-[#f5f1e8] px-3 py-2 text-[11px] font-semibold text-charcoal/70"><span className={clsx("h-2 w-2", statusColour(task))} aria-hidden />{agentAssignmentStatusLabel(task)}</span></div>
      {(draftArtifacts.length > 0 || terminal || task.status === "queued" || task.status === "running") && <a href={draftArtifacts.length > 0 ? `#review-actions-${draftArtifacts[0].id}` : `#${actionsId}`} className="mt-4 inline-flex min-h-11 items-center text-[12px] font-semibold text-[#274690] underline decoration-[#a08c72] underline-offset-4 lg:hidden">Jump to {draftArtifacts.length > 0 ? "decision" : "actions"} ↓</a>}
    </header>

    <details className="border-b border-[#cfc5b6] py-2"><summary className="flex min-h-11 cursor-pointer items-center text-[11px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">Assignment brief</summary><p className="pb-4 whitespace-pre-wrap text-[14px] leading-6 text-charcoal/72">{task.objective}</p></details>

    {task.progress_label && task.status !== "failed" && <div className="mt-5 border-l-2 border-[#274690] bg-[#eef3fb] px-4 py-3 text-[14px] text-[#20375f]">{task.progress_label}</div>}
    {recovery ? <section className="mt-5 border border-[#d7cdbd] bg-[#faf6ec]" aria-label="Recovery guide"><div className="border-b border-[#e1d8ca] px-4 py-3"><p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-red-800">What happened</p><p className="mt-2 text-[14px] leading-6 text-charcoal/75">{recovery.whatHappened}</p></div><div className="px-4 py-3"><p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#274690]">Next safe step</p><p className="mt-2 text-[14px] leading-6 text-charcoal/75">{recovery.nextStep}</p></div>{task.error && recovery.whatHappened !== task.error.trim() && <details className="border-t border-[#e1d8ca] px-4 py-2"><summary className="flex min-h-11 cursor-pointer items-center text-[10px] font-semibold uppercase tracking-[0.13em] text-charcoal/50">Technical failure message</summary><p className="pb-3 text-[12px] leading-5 text-red-900">{task.error}</p></details>}</section> : task.error && <div className="mt-5 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-[14px] leading-6 text-red-900">{task.error}</div>}
    {task.result_summary && <div className="mt-5 border-l-2 border-[#3f7958] bg-[#edf5ef] px-4 py-3 text-[14px] leading-6 text-[#254c36]">{task.result_summary}</div>}

    {task.status === "awaiting_approval" && draftArtifacts.length === 0 && <section className="mt-7 border border-red-200 bg-[#faf6ec] p-6"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700">Review pack incomplete</p><h3 className="mt-3 font-display text-[28px] text-nearblack">There is nothing safe to approve yet.</h3><p className="mt-3 max-w-2xl text-[14px] leading-6 text-charcoal/70">The agent paused for approval without attaching the proposed content, evidence or exact action. Open the conversation and ask the agent to rebuild the review pack.</p><Link href={`/messages?conversation=${encodeURIComponent(task.conversation_id)}`} className="mt-5 inline-flex min-h-11 items-center bg-nearblack px-4 text-[13px] font-semibold text-white">Open conversation</Link></section>}

    {draftArtifacts.length > 0 && <div className="mt-7 space-y-8" aria-label="Evidence and approvals">{draftArtifacts.map((artifact) => <ArtifactDecision key={artifact.id} task={task} artifact={artifact} policies={policies} busy={busy} onAction={onAction} />)}</div>}

    {task.events.length > 0 && <details className="mt-8 border-t border-[#cfc5b6] pt-5"><summary className="flex min-h-11 cursor-pointer items-center justify-between text-[12px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">Activity <span className="font-normal text-charcoal/45">{task.events.length} updates</span></summary><ol className="mt-3 space-y-3 border-l border-[#cbbda7] pl-4">{[...task.events].reverse().slice(0, 16).map((event) => <li key={event.id} className="grid gap-1 text-[12px] sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3"><time className="text-charcoal/45">{dateTime(event.created_at)}</time><div><span className="font-semibold text-nearblack">{event.label}</span>{event.detail && <p className="mt-1 leading-5 text-charcoal/60">{event.detail}</p>}</div></li>)}</ol></details>}

    <div id={actionsId} className="workroom-task-actions sticky bottom-0 z-10 -mx-4 mt-8 flex flex-wrap gap-2 border-y border-[#cfc5b6] bg-[#faf6ec]/[0.97] px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-x-0 lg:border-b-0 lg:bg-transparent lg:px-0 lg:pt-5 lg:backdrop-blur-none"><Link href={`/messages?conversation=${encodeURIComponent(task.conversation_id)}`} className="inline-flex min-h-11 items-center border border-nearblack px-4 text-[13px] font-semibold text-nearblack hover:bg-nearblack hover:text-white">Open conversation</Link>{(task.status === "queued" || task.status === "running") && <button disabled={Boolean(busy)} onClick={() => onAction(task, "cancel")} className="min-h-11 border border-red-300 px-4 text-[13px] font-semibold text-red-800 disabled:opacity-40">Stop task</button>}{task.status === "failed" && task.requested_by === selfId && task.retry_count < 3 && <button disabled={Boolean(busy)} onClick={() => onAction(task, "retry")} className="min-h-11 bg-nearblack px-4 text-[13px] font-semibold text-white disabled:opacity-40">{busy ? "Checking current state…" : "Retry safely"}</button>}{terminal && <button disabled={Boolean(busy)} onClick={() => onAction(task, "dismiss")} className="min-h-11 border border-[#cfc5b6] px-4 text-[13px] font-semibold disabled:opacity-40">Clear from Workroom</button>}</div>
  </article>;
}

function ArtifactDecision({ task, artifact, policies, busy, onAction }: { task: WorkroomTask; artifact: AgentTaskArtifact; policies: WorkroomApprovalPolicy[]; busy: string | null; onAction: (task: WorkroomTask, action: TaskAction, artifactId?: string, note?: string) => void }) {
  const [feedbackMode, setFeedbackMode] = useState<"changes" | "decline" | null>(null);
  const [note, setNote] = useState("");
  const request = authorityRequest(artifact);
  const policy = policyForArtifact(artifact, policies);
  const missingAssets = inaccessibleAssets(artifact);
  const mediaIssue = reviewMediaIssue(artifact);
  const timingIssue = authorityTimingIssue(artifact);
  const hasPreview = artifactHasUsefulPreview(artifact);
  const blockedReason = !hasPreview ? "The review pack has no visible content." : request && !policy ? "This execution tool is not registered in RESLU's approval system." : timingIssue ? timingIssue : mediaIssue ? `The private review previews could not be prepared: ${mediaIssue}` : missingAssets.length ? `${missingAssets.length} image ${missingAssets.length === 1 ? "is" : "are"} still stored as a local file and cannot be reviewed on this device.` : null;
  const actionLabel = approvalActionLabel(artifact, policy);
  const actionBusy = busy === `${task.id}:${artifact.id}`;

  function sendFeedback() {
    const clean = note.trim();
    if (!clean) return;
    onAction(task, feedbackMode === "decline" ? "reject" : "request_changes", artifact.id, clean);
  }

  return <section>
    <ReviewArtifact artifact={artifact} policy={policy} />
    {blockedReason && <div id={`review-block-${artifact.id}`} className="border-x border-b border-red-200 bg-red-50 px-5 py-4 text-[13px] leading-6 text-red-900 sm:px-7"><strong>Decision paused.</strong> {blockedReason}{missingAssets.length > 0 && <p className="mt-2 text-[11px] text-red-800">The agent must upload reviewable previews tied to the original file hashes before approval.</p>}</div>}

    <div id={`review-actions-${artifact.id}`} className="workroom-action-bar sticky bottom-0 z-10 mt-4 border border-[#cfc5b6] bg-[#faf6ec]/[0.97] px-4 pt-4 backdrop-blur sm:px-5">
      {feedbackMode ? <div className="pb-4"><label htmlFor={`review-note-${artifact.id}`} className="text-[12px] font-semibold text-nearblack">{feedbackMode === "changes" ? "What should the agent change?" : "Why are you declining this pack?"}</label><textarea id={`review-note-${artifact.id}`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} autoFocus maxLength={2000} placeholder="Be specific about the image, wording, amount or action…" className="mt-2 w-full resize-y border border-[#bfb3a1] bg-white px-3 py-3 text-[16px] leading-6 text-nearblack placeholder:text-charcoal/45" /><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => { setFeedbackMode(null); setNote(""); }} className="min-h-11 px-4 text-[13px] font-semibold text-charcoal/65">Cancel</button><button type="button" disabled={Boolean(busy) || !note.trim()} onClick={sendFeedback} className={clsx("min-h-11 px-4 text-[13px] font-semibold text-white disabled:opacity-35", feedbackMode === "decline" ? "bg-red-800" : "bg-nearblack")}>{actionBusy ? "Sending…" : feedbackMode === "decline" ? "Decline pack" : "Send changes"}</button></div></div> : <div className="flex flex-wrap items-center justify-between gap-3 pb-4"><div className="flex flex-wrap gap-1"><button type="button" disabled={Boolean(busy)} onClick={() => setFeedbackMode("changes")} className="min-h-11 px-3 text-[13px] font-semibold text-nearblack hover:bg-[#eee7dc]">Request changes</button><button type="button" disabled={Boolean(busy)} onClick={() => setFeedbackMode("decline")} className="min-h-11 px-3 text-[13px] font-semibold text-red-800 hover:bg-red-50">Decline</button></div><button type="button" aria-describedby={blockedReason ? `review-block-${artifact.id}` : undefined} disabled={Boolean(busy) || Boolean(blockedReason)} onClick={() => onAction(task, "approve", artifact.id)} className="min-h-12 min-w-[10rem] bg-nearblack px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#313131] disabled:cursor-not-allowed disabled:bg-charcoal/25">{actionBusy ? "Saving decision…" : actionLabel}</button></div>}
    </div>
  </section>;
}
