"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { agentAssignmentStatusLabel, artifactSummary, assignmentLastUpdatedAt } from "@/lib/agent-operating-workspace";
import { filterWorkroomTasks, workroomCounts, type WorkroomView } from "@/lib/workroom";
import type { WorkroomResponse, WorkroomTask } from "@/types/workroom";

const VIEWS: Array<{ id: WorkroomView; label: string }> = [
  { id: "attention", label: "Needs you" },
  { id: "outstanding", label: "Outstanding" },
  { id: "recurring", label: "Recurring" },
  { id: "history", label: "History" },
];

function dateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusTone(task: WorkroomTask) {
  if (task.status === "awaiting_approval") return "bg-amber-100 text-amber-900";
  if (task.status === "failed") return "bg-red-100 text-red-800";
  if (task.status === "completed") return "bg-emerald-100 text-emerald-900";
  if (task.status === "cancelled") return "bg-charcoal/10 text-charcoal/60";
  return "bg-blue-100 text-blue-900";
}

export function WorkroomWorkspace({ conversationId = null }: { conversationId?: string | null }) {
  const [data, setData] = useState<WorkroomResponse | null>(null);
  const [view, setView] = useState<WorkroomView>("attention");
  const [agentId, setAgentId] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
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
  const filtered = useMemo(() => filterWorkroomTasks(tasks, view, agentId), [agentId, tasks, view]);
  const selected = filtered.find((task) => task.id === selectedId) ?? filtered[0] ?? null;

  async function taskAction(task: WorkroomTask, action: "cancel" | "retry" | "dismiss" | "approve" | "reject", artifactId?: string) {
    setBusy(`${task.id}:${artifactId ?? action}`);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${task.conversation_id}/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, artifact_id: artifactId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update this task");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this task");
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <div className="border border-[#d4cbbd] bg-offwhite p-8 text-body text-charcoal/55">Opening the Workroom…</div>;

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      {error && <div role="alert" className="border border-red-300 bg-red-50 px-4 py-3 text-body text-red-800">{error}</div>}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Workroom summary">
        <Summary label="Needs you" value={counts.attention} tone={counts.attention ? "attention" : "plain"} />
        <Summary label="Outstanding" value={counts.outstanding} />
        <Summary label="Agents with work" value={new Set(tasks.filter((task) => !["completed", "cancelled"].includes(task.status)).map((task) => task.owner_agent_id)).size} />
        <Summary label="Recurring routines" value={data?.routines.length ?? 0} />
      </section>

      {conversationId && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-[#d4cbbd] bg-[#eee8de] px-4 py-3 text-caption">
          <span>Showing work from one conversation.</span>
          <Link href="/workroom" className="font-semibold underline underline-offset-4">Show all agent work</Link>
        </div>
      )}

      <section className="border border-[#cfc6b8] bg-offwhite">
        <div className="flex flex-col gap-3 border-b border-[#d4cbbd] p-3 md:flex-row md:items-center md:justify-between md:px-5">
          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Workroom views">
            {VIEWS.map((item) => {
              const count = item.id === "recurring" ? data?.routines.length ?? 0 : counts[item.id];
              return (
                <button key={item.id} type="button" role="tab" aria-selected={view === item.id} onClick={() => { setView(item.id); setSelectedId(null); }} className={clsx("min-h-11 shrink-0 px-3 text-caption font-semibold", view === item.id ? "bg-nearblack text-white" : "text-charcoal/60 hover:bg-[#eee8de]")}>{item.label} <span className="ml-1 opacity-60">{count}</span></button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-caption text-charcoal/55">
            Agent
            <select value={agentId} onChange={(event) => { setAgentId(event.target.value); setSelectedId(null); }} className="min-h-11 border border-[#cfc6b8] bg-white px-3 text-body text-nearblack">
              <option value="all">All agents</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}
            </select>
          </label>
        </div>

        {view === "recurring" ? (
          <div className="grid gap-px bg-[#d4cbbd] md:grid-cols-2 xl:grid-cols-3">
            {(data?.routines ?? []).filter((routine) => agentId === "all" || agents.find((agent) => agent.id === agentId)?.display_name === routine.owner).map((routine) => (
              <article key={routine.id} className="bg-offwhite p-5">
                <div className="flex items-start justify-between gap-3"><h2 className="text-body font-semibold text-nearblack">{routine.label}</h2><span className="bg-[#e7dfd1] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-charcoal/65">{routine.owner}</span></div>
                <p className="mt-4 text-subhead text-charcoal/70">{routine.cadence}</p>
                <p className="mt-1 font-mono text-[11px] text-charcoal/45">{routine.schedule} · UTC</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="grid min-h-[520px] lg:grid-cols-[minmax(280px,0.78fr)_minmax(420px,1.5fr)]">
            <div className="border-b border-[#d4cbbd] lg:border-b-0 lg:border-r">
              {filtered.length ? filtered.map((task) => (
                <button key={task.id} type="button" onClick={() => setSelectedId(task.id)} className={clsx("block w-full border-b border-[#e1dacf] p-4 text-left", selected?.id === task.id ? "bg-[#e9e1d4]" : "hover:bg-[#f5f1e8]")}>
                  <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-charcoal/50">{task.owner_agent?.display_name ?? "Agent"}</span><span className={clsx("px-2 py-1 text-[10px] font-semibold", statusTone(task))}>{agentAssignmentStatusLabel(task)}</span></div>
                  <p className="mt-2 text-body font-semibold leading-snug text-nearblack">{task.title}</p>
                  <p className="mt-2 truncate text-caption text-charcoal/50">{task.conversation.title} · {dateTime(assignmentLastUpdatedAt(task))}</p>
                </button>
              )) : <Empty view={view} />}
            </div>
            <div className="min-w-0 p-5 md:p-7">{selected ? <TaskDetail task={selected} selfId={data?.self_profile_id ?? ""} busy={busy} onAction={taskAction} /> : <div className="flex min-h-80 items-center justify-center text-center text-body text-charcoal/45">Choose an assignment to see its brief, progress, evidence and controls.</div>}</div>
          </div>
        )}
      </section>
    </div>
  );
}

function Summary({ label, value, tone = "plain" }: { label: string; value: number; tone?: "plain" | "attention" }) {
  return <article className={clsx("border p-4 md:p-5", tone === "attention" ? "border-amber-400 bg-amber-50" : "border-[#d4cbbd] bg-offwhite")}><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-charcoal/50">{label}</p><p className="mt-2 font-display text-[30px] leading-none text-nearblack">{value}</p></article>;
}

function Empty({ view }: { view: WorkroomView }) {
  const copy = view === "attention" ? "Nothing needs your approval or recovery." : view === "outstanding" ? "No work is currently queued or running." : "No completed work is available.";
  return <div className="p-8 text-center text-body text-charcoal/50">{copy}</div>;
}

function TaskDetail({ task, selfId, busy, onAction }: { task: WorkroomTask; selfId: string; busy: string | null; onAction: (task: WorkroomTask, action: "cancel" | "retry" | "dismiss" | "approve" | "reject", artifactId?: string) => void }) {
  const draftArtifacts = task.artifacts.filter((artifact) => artifact.status === "draft");
  const terminal = ["failed", "completed", "cancelled"].includes(task.status);
  return (
    <article>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0"><p className="label-caps">{task.owner_agent?.display_name ?? "Agent"} · {task.conversation.title}</p><h2 className="mt-2 max-w-3xl font-display text-section leading-tight text-nearblack">{task.title}</h2></div>
        <span className={clsx("px-3 py-2 text-caption font-semibold", statusTone(task))}>{agentAssignmentStatusLabel(task)}</span>
      </div>
      <p className="mt-5 whitespace-pre-wrap text-body leading-7 text-charcoal/75">{task.objective}</p>
      {task.progress_label && <div className="mt-5 border-l-2 border-blue-700 bg-blue-50 px-4 py-3 text-body text-blue-950">{task.progress_label}</div>}
      {task.error && <div className="mt-5 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-body text-red-800">{task.error}</div>}
      {task.result_summary && <div className="mt-5 border-l-2 border-emerald-700 bg-emerald-50 px-4 py-3 text-body leading-6 text-emerald-950">{task.result_summary}</div>}

      {task.artifacts.length > 0 && <section className="mt-7"><h3 className="label-caps mb-3">Evidence and approvals</h3><div className="divide-y divide-[#d4cbbd] border-y border-[#d4cbbd]">{task.artifacts.map((artifact) => (
        <div key={artifact.id} className="py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-body font-semibold text-nearblack">{artifact.title}</p><p className="mt-1 whitespace-pre-wrap text-caption leading-5 text-charcoal/65">{artifactSummary(artifact)}</p></div><span className="text-[10px] uppercase tracking-wider text-charcoal/45">{artifact.status}</span></div>
          {artifact.status === "draft" && <div className="mt-3 flex gap-2"><button disabled={Boolean(busy)} onClick={() => onAction(task, "reject", artifact.id)} className="min-h-10 border border-[#cfc6b8] px-3 text-caption font-semibold disabled:opacity-40">Reject</button><button disabled={Boolean(busy)} onClick={() => onAction(task, "approve", artifact.id)} className="min-h-10 bg-nearblack px-3 text-caption font-semibold text-white disabled:opacity-40">Approve</button></div>}
        </div>
      ))}</div></section>}

      {task.events.length > 0 && <section className="mt-7"><h3 className="label-caps mb-3">Activity</h3><ol className="space-y-3">{[...task.events].reverse().slice(0, 12).map((event) => <li key={event.id} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 text-caption"><time className="text-charcoal/40">{dateTime(event.created_at)}</time><div><span className="font-semibold text-nearblack">{event.label}</span>{event.detail && <p className="mt-0.5 text-charcoal/60">{event.detail}</p>}</div></li>)}</ol></section>}

      <div className="mt-8 flex flex-wrap gap-2 border-t border-[#d4cbbd] pt-5">
        <Link href={`/messages?conversation=${encodeURIComponent(task.conversation_id)}`} className="inline-flex min-h-11 items-center bg-nearblack px-4 text-caption font-semibold text-white">Open conversation</Link>
        {(task.status === "queued" || task.status === "running") && <button disabled={Boolean(busy)} onClick={() => onAction(task, "cancel")} className="min-h-11 border border-red-300 px-4 text-caption font-semibold text-red-800 disabled:opacity-40">Stop task</button>}
        {task.status === "failed" && task.requested_by === selfId && task.retry_count < 3 && <button disabled={Boolean(busy)} onClick={() => onAction(task, "retry")} className="min-h-11 border border-[#cfc6b8] px-4 text-caption font-semibold disabled:opacity-40">Retry</button>}
        {terminal && <button disabled={Boolean(busy)} onClick={() => onAction(task, "dismiss")} className="min-h-11 border border-[#cfc6b8] px-4 text-caption font-semibold disabled:opacity-40">Clear from Workroom</button>}
      </div>
      {draftArtifacts.length > 0 && <p className="mt-3 text-caption text-amber-800">{draftArtifacts.length} item{draftArtifacts.length === 1 ? "" : "s"} waiting for your decision.</p>}
    </article>
  );
}
