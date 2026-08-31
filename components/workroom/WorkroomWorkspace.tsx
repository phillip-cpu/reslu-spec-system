"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { agentAssignmentStatusLabel, assignmentLastUpdatedAt } from "@/lib/agent-operating-workspace";
import { filterWorkroomTasks, workroomCounts, type WorkroomView } from "@/lib/workroom";
import {
  approvalActionLabel,
  artifactHasUsefulPreview,
  authorityTimingIssue,
  authorityRequest,
  inaccessibleAssets,
  policyForArtifact,
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

export function WorkroomWorkspace({ conversationId = null }: { conversationId?: string | null }) {
  const [data, setData] = useState<WorkroomResponse | null>(null);
  const [view, setView] = useState<WorkroomView>("approvals");
  const [agentId, setAgentId] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const actionLock = useRef<string | null>(null);

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
  const filtered = useMemo(() => filterWorkroomTasks(tasks, view, agentId), [agentId, tasks, view]);
  const selected = filtered.find((task) => task.id === selectedId) ?? filtered[0] ?? null;
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
    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }));
    }
  }

  if (loading && !data) return <WorkroomSkeleton />;

  return (
    <div className="workroom-surface -mx-4 -my-5 min-h-[calc(100vh-92px)] px-4 py-5 md:-mx-8 md:-my-8 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1540px]">
        <div className="mb-5 flex flex-col gap-4 border-b border-[#cfc5b6] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#76634f]">Studio work table</p>
            <p className="workroom-ink-note mt-2">What needs your eye, without the noise.</p>
          </div>
          <dl className="flex flex-wrap gap-x-7 gap-y-3 text-[12px] text-charcoal/65">
            <div><dt className="inline">Approvals </dt><dd className="inline font-semibold text-nearblack">{counts.approvals}</dd></div>
            <div><dt className="inline">Recovery </dt><dd className="inline font-semibold text-nearblack">{counts.recovery}</dd></div>
            <div><dt className="inline">Outstanding </dt><dd className="inline font-semibold text-nearblack">{counts.outstanding}</dd></div>
            <div><dt className="inline">Recurring </dt><dd className="inline font-semibold text-nearblack">{data?.routines.length ?? 0}</dd></div>
          </dl>
        </div>

        {error && <div role="alert" className="mb-4 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-[14px] text-red-900">{error}</div>}
        {notice && <div role="status" aria-live="polite" className="mb-4 border-l-2 border-[#3f7958] bg-[#edf5ef] px-4 py-3 text-[14px] text-[#254c36]">{notice}</div>}

        {conversationId && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-[#d4cbbd] bg-[#f5f1e8] px-4 py-3 text-[12px]"><span>Showing assignments from one conversation.</span><Link href="/workroom" className="font-semibold underline underline-offset-4">Show the whole Workroom</Link></div>}

        <section className="overflow-hidden border border-[#cfc5b6] bg-[#f5f1e8]/80">
          <div className="flex flex-col gap-3 border-b border-[#cfc5b6] bg-[#eee7dc] p-3 md:flex-row md:items-center md:justify-between md:px-4">
            <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Workroom views">
              {VIEWS.map((item) => {
                const count = item.id === "recurring" ? data?.routines.length ?? 0 : counts[item.id];
                return <button key={item.id} type="button" role="tab" aria-selected={view === item.id} onClick={() => { setView(item.id); setSelectedId(null); setMobileDetailOpen(false); setNotice(null); }} className={clsx("min-h-11 shrink-0 border-b-2 px-3 text-[12px] font-semibold transition-colors", view === item.id ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/55 hover:text-nearblack")}><span>{item.label}</span><span className="ml-2 font-normal text-charcoal/45">{count}</span><span className="sr-only"> · {item.quietLabel}</span></button>;
              })}
            </div>
            <label className="flex items-center gap-2 text-[12px] text-charcoal/60"><span>Agent</span><select value={agentId} onChange={(event) => { setAgentId(event.target.value); setSelectedId(null); setMobileDetailOpen(false); }} className="min-h-11 border border-[#cfc5b6] bg-[#faf6ec] px-3 text-[14px] text-nearblack"><option value="all">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label>
          </div>

          {view === "recurring" ? <RoutineGrid routines={data?.routines ?? []} agents={agents} agentId={agentId} /> : (
            <div className="grid min-h-[620px] lg:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.55fr)] xl:grid-cols-[370px_minmax(0,1fr)]">
              <div className={clsx("border-[#cfc5b6] bg-[#f5f1e8] lg:block lg:border-r", mobileDetailOpen ? "hidden" : "block")}>
                {filtered.length ? filtered.map((task) => <TaskQueueRow key={task.id} task={task} selected={selected?.id === task.id} onSelect={() => selectTask(task.id)} />) : <Empty view={view} />}
              </div>
              <div className={clsx("min-w-0 bg-[#ede8de] lg:block", mobileDetailOpen ? "block" : "hidden")}>
                {selected ? <TaskDetail task={selected} selfId={data?.self_profile_id ?? ""} policies={policies} busy={busy} onBack={() => setMobileDetailOpen(false)} onAction={taskAction} /> : <div className="flex min-h-[620px] items-center justify-center p-8 text-center text-[14px] text-charcoal/50">Choose an assignment to review its work, evidence and next action.</div>}
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

function TaskQueueRow({ task, selected, onSelect }: { task: WorkroomTask; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className={clsx("workroom-queue-row block min-h-[94px] w-full border-b border-[#ddd5c8] px-5 py-4 text-left", selected ? "bg-[#faf6ec]" : "hover:bg-[#f9f4ea]")}>
    <div className="flex items-center justify-between gap-3"><span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#76634f]">{task.owner_agent?.display_name ?? "Agent"}</span><span className="flex items-center gap-2 text-[11px] text-charcoal/60"><span className={clsx("h-2 w-2", statusColour(task))} aria-hidden />{agentAssignmentStatusLabel(task)}</span></div>
    <p className="mt-2 text-[15px] font-medium leading-snug text-nearblack">{task.title}</p>
    <p className="mt-2 truncate text-[11px] text-charcoal/50">{task.conversation.title} · {dateTime(assignmentLastUpdatedAt(task))}</p>
  </button>;
}

function Empty({ view }: { view: WorkroomView }) {
  const copy = view === "approvals" ? ["Nothing awaiting approval", "No agent is waiting on a decision from you."] : view === "recovery" ? ["Nothing needs recovery", "There is no failed work to inspect or retry."] : view === "outstanding" ? ["No active assignments", "The agents have no queued or running work."] : ["No history yet", "Completed work will settle here."];
  return <div className="flex min-h-72 flex-col justify-center px-8 text-center"><p className="font-display text-[25px] text-nearblack">{copy[0]}</p><p className="mt-2 text-[13px] leading-6 text-charcoal/55">{copy[1]}</p></div>;
}

function RoutineGrid({ routines, agents, agentId }: { routines: WorkroomResponse["routines"]; agents: Array<NonNullable<WorkroomTask["owner_agent"]>>; agentId: string }) {
  const visible = routines.filter((routine) => agentId === "all" || agents.find((agent) => agent.id === agentId)?.display_name === routine.owner);
  return <div className="grid gap-px bg-[#d4cbbd] md:grid-cols-2 xl:grid-cols-3">{visible.map((routine, index) => <article key={routine.id} className="min-h-48 bg-[#faf6ec] p-6"><div className="flex items-start justify-between gap-4"><span className="font-display text-[34px] leading-none text-[#c8b99f]">{String(index + 1).padStart(2, "0")}</span><span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#76634f]">{routine.owner}</span></div><h2 className="mt-6 font-display text-[25px] leading-tight text-nearblack">{routine.label}</h2><p className="mt-4 text-[13px] text-charcoal/65">{routine.cadence}</p><p className="mt-1 font-mono text-[11px] text-charcoal/45">{routine.schedule} · UTC</p></article>)}</div>;
}

function TaskDetail({ task, selfId, policies, busy, onBack, onAction }: { task: WorkroomTask; selfId: string; policies: WorkroomApprovalPolicy[]; busy: string | null; onBack: () => void; onAction: (task: WorkroomTask, action: TaskAction, artifactId?: string, note?: string) => void }) {
  const draftArtifacts = task.artifacts.filter((artifact) => artifact.status === "draft");
  const terminal = ["failed", "completed", "cancelled"].includes(task.status);
  return <article className="mx-auto max-w-[1040px] px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-9">
    <button type="button" onClick={onBack} className="mb-5 inline-flex min-h-11 items-center gap-2 text-[13px] font-semibold text-charcoal/65 lg:hidden"><span aria-hidden>←</span> Back to Workroom</button>
    <header className="border-b border-[#cfc5b6] pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.19em] text-[#76634f]">{task.owner_agent?.display_name ?? "Agent"} · {task.conversation.title}</p><h2 className="mt-3 max-w-3xl font-display text-[34px] font-light leading-[1.05] text-nearblack sm:text-[42px]">{task.title}</h2></div><span className="flex items-center gap-2 border border-[#cbbda7] bg-[#f5f1e8] px-3 py-2 text-[11px] font-semibold text-charcoal/70"><span className={clsx("h-2 w-2", statusColour(task))} aria-hidden />{agentAssignmentStatusLabel(task)}</span></div>
    </header>

    <details className="border-b border-[#cfc5b6] py-2"><summary className="flex min-h-11 cursor-pointer items-center text-[11px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">Assignment brief</summary><p className="pb-4 whitespace-pre-wrap text-[14px] leading-6 text-charcoal/72">{task.objective}</p></details>

    {task.progress_label && <div className="mt-5 border-l-2 border-[#274690] bg-[#eef3fb] px-4 py-3 text-[14px] text-[#20375f]">{task.progress_label}</div>}
    {task.error && <div className="mt-5 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-[14px] leading-6 text-red-900">{task.error}</div>}
    {task.result_summary && <div className="mt-5 border-l-2 border-[#3f7958] bg-[#edf5ef] px-4 py-3 text-[14px] leading-6 text-[#254c36]">{task.result_summary}</div>}

    {task.status === "awaiting_approval" && draftArtifacts.length === 0 && <section className="mt-7 border border-red-200 bg-[#faf6ec] p-6"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700">Review pack incomplete</p><h3 className="mt-3 font-display text-[28px] text-nearblack">There is nothing safe to approve yet.</h3><p className="mt-3 max-w-2xl text-[14px] leading-6 text-charcoal/70">The agent paused for approval without attaching the proposed content, evidence or exact action. Open the conversation and ask the agent to rebuild the review pack.</p><Link href={`/messages?conversation=${encodeURIComponent(task.conversation_id)}`} className="mt-5 inline-flex min-h-11 items-center bg-nearblack px-4 text-[13px] font-semibold text-white">Open conversation</Link></section>}

    {draftArtifacts.length > 0 && <div className="mt-7 space-y-8" aria-label="Evidence and approvals">{draftArtifacts.map((artifact) => <ArtifactDecision key={artifact.id} task={task} artifact={artifact} policies={policies} busy={busy} onAction={onAction} />)}</div>}

    {task.events.length > 0 && <details className="mt-8 border-t border-[#cfc5b6] pt-5"><summary className="flex min-h-11 cursor-pointer items-center justify-between text-[12px] font-semibold uppercase tracking-[0.14em] text-[#76634f]">Activity <span className="font-normal text-charcoal/45">{task.events.length} updates</span></summary><ol className="mt-3 space-y-3 border-l border-[#cbbda7] pl-4">{[...task.events].reverse().slice(0, 16).map((event) => <li key={event.id} className="grid gap-1 text-[12px] sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3"><time className="text-charcoal/45">{dateTime(event.created_at)}</time><div><span className="font-semibold text-nearblack">{event.label}</span>{event.detail && <p className="mt-1 leading-5 text-charcoal/60">{event.detail}</p>}</div></li>)}</ol></details>}

    <div className="mt-8 flex flex-wrap gap-2 border-t border-[#cfc5b6] pt-5"><Link href={`/messages?conversation=${encodeURIComponent(task.conversation_id)}`} className="inline-flex min-h-11 items-center border border-nearblack px-4 text-[13px] font-semibold text-nearblack hover:bg-nearblack hover:text-white">Open conversation</Link>{(task.status === "queued" || task.status === "running") && <button disabled={Boolean(busy)} onClick={() => onAction(task, "cancel")} className="min-h-11 border border-red-300 px-4 text-[13px] font-semibold text-red-800 disabled:opacity-40">Stop task</button>}{task.status === "failed" && task.requested_by === selfId && task.retry_count < 3 && <button disabled={Boolean(busy)} onClick={() => onAction(task, "retry")} className="min-h-11 bg-nearblack px-4 text-[13px] font-semibold text-white disabled:opacity-40">{busy ? "Checking current state…" : "Retry safely"}</button>}{terminal && <button disabled={Boolean(busy)} onClick={() => onAction(task, "dismiss")} className="min-h-11 border border-[#cfc5b6] px-4 text-[13px] font-semibold disabled:opacity-40">Clear from Workroom</button>}</div>
  </article>;
}

function ArtifactDecision({ task, artifact, policies, busy, onAction }: { task: WorkroomTask; artifact: AgentTaskArtifact; policies: WorkroomApprovalPolicy[]; busy: string | null; onAction: (task: WorkroomTask, action: TaskAction, artifactId?: string, note?: string) => void }) {
  const [feedbackMode, setFeedbackMode] = useState<"changes" | "decline" | null>(null);
  const [note, setNote] = useState("");
  const request = authorityRequest(artifact);
  const policy = policyForArtifact(artifact, policies);
  const missingAssets = inaccessibleAssets(artifact);
  const timingIssue = authorityTimingIssue(artifact);
  const hasPreview = artifactHasUsefulPreview(artifact);
  const blockedReason = !hasPreview ? "The review pack has no visible content." : request && !policy ? "This execution tool is not registered in RESLU's approval system." : timingIssue ? timingIssue : missingAssets.length ? `${missingAssets.length} image ${missingAssets.length === 1 ? "is" : "are"} still stored as a local file and cannot be reviewed on this device.` : null;
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

    <div className="workroom-action-bar sticky bottom-0 z-10 mt-4 border border-[#cfc5b6] bg-[#faf6ec]/[0.97] px-4 pt-4 backdrop-blur sm:px-5">
      {feedbackMode ? <div className="pb-4"><label htmlFor={`review-note-${artifact.id}`} className="text-[12px] font-semibold text-nearblack">{feedbackMode === "changes" ? "What should the agent change?" : "Why are you declining this pack?"}</label><textarea id={`review-note-${artifact.id}`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} autoFocus maxLength={2000} placeholder="Be specific about the image, wording, amount or action…" className="mt-2 w-full resize-y border border-[#bfb3a1] bg-white px-3 py-3 text-[16px] leading-6 text-nearblack placeholder:text-charcoal/45" /><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => { setFeedbackMode(null); setNote(""); }} className="min-h-11 px-4 text-[13px] font-semibold text-charcoal/65">Cancel</button><button type="button" disabled={Boolean(busy) || !note.trim()} onClick={sendFeedback} className={clsx("min-h-11 px-4 text-[13px] font-semibold text-white disabled:opacity-35", feedbackMode === "decline" ? "bg-red-800" : "bg-nearblack")}>{actionBusy ? "Sending…" : feedbackMode === "decline" ? "Decline pack" : "Send changes"}</button></div></div> : <div className="flex flex-wrap items-center justify-between gap-3 pb-4"><div className="flex flex-wrap gap-1"><button type="button" disabled={Boolean(busy)} onClick={() => setFeedbackMode("changes")} className="min-h-11 px-3 text-[13px] font-semibold text-nearblack hover:bg-[#eee7dc]">Request changes</button><button type="button" disabled={Boolean(busy)} onClick={() => setFeedbackMode("decline")} className="min-h-11 px-3 text-[13px] font-semibold text-red-800 hover:bg-red-50">Decline</button></div><button type="button" aria-describedby={blockedReason ? `review-block-${artifact.id}` : undefined} disabled={Boolean(busy) || Boolean(blockedReason)} onClick={() => onAction(task, "approve", artifact.id)} className="min-h-12 min-w-[10rem] bg-nearblack px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#313131] disabled:cursor-not-allowed disabled:bg-charcoal/25">{actionBusy ? "Saving decision…" : actionLabel}</button></div>}
    </div>
  </section>;
}
