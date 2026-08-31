"use client";

import Image from "next/image";
import { FormEvent, useMemo, useState } from "react";
import clsx from "clsx";
import {
  agentAssignmentStatusLabel,
  agentAssignmentView,
  approvalArtifacts,
  artifactSummary,
  assignmentLastUpdatedAt,
  changeArtifacts,
  evidenceArtifacts,
  filterAgentAssignments,
  latestAgentComputerState,
  messagesForAgentAssignment,
  type AgentAssignmentTab,
  type AgentAssignmentView,
} from "@/lib/agent-operating-workspace";
import type {
  AgentTask,
  AgentTaskArtifact,
  ConversationAgentActivity,
  ConversationMessage,
  ConversationParticipant,
} from "@/types/conversations";

type TaskAction = "cancel" | "retry" | "dismiss" | "approve" | "reject";

interface AgentOperatingWorkspaceProps {
  conversationId: string;
  conversationTitle: string;
  agent: ConversationParticipant | null;
  tasks: AgentTask[];
  messages: ConversationMessage[];
  agentActivity: ConversationAgentActivity[];
  selfParticipant: ConversationParticipant | null;
  onTaskAction: (taskId: string, action: TaskAction, artifactId?: string) => void;
  onRefresh: () => Promise<void> | void;
}

const VIEW_LABELS: Record<AgentAssignmentView, string> = {
  active: "Active",
  waiting: "Waiting",
  done: "Done",
};

const TAB_LABELS: Record<AgentAssignmentTab, string> = {
  chat: "Chat",
  activity: "Activity",
  evidence: "Evidence",
  changes: "Changes",
  approvals: "Approvals",
};

function shortDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function taskStatusTone(task: AgentTask) {
  if (task.status === "awaiting_approval") return "bg-amber-600";
  if (task.status === "failed") return "bg-red-700";
  if (task.status === "completed") return "bg-emerald-800";
  if (task.status === "cancelled") return "bg-charcoal/45";
  return "bg-[#355e4b]";
}

function taskStatusDot(task: AgentTask) {
  if (task.status === "awaiting_approval") return "bg-amber-600";
  if (task.status === "failed") return "bg-red-700";
  if (task.status === "completed") return "bg-emerald-700";
  if (task.status === "cancelled") return "bg-charcoal/40";
  return "bg-[#355e4b]";
}

function ArtifactRows({
  artifacts,
  empty,
  onTaskAction,
}: {
  artifacts: AgentTaskArtifact[];
  empty: string;
  onTaskAction?: (action: "approve" | "reject", artifactId: string) => void;
}) {
  if (artifacts.length === 0) {
    return <p className="border-t border-[#d8cebf] py-8 text-center text-caption text-charcoal/55">{empty}</p>;
  }
  return (
    <div className="divide-y divide-[#d8cebf] border-y border-[#d8cebf]">
      {artifacts.map((artifact) => (
        <article key={artifact.id} className="grid gap-3 py-4 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-start">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center bg-[#e7dfd1] text-caption font-semibold uppercase text-charcoal/65">
            {artifact.kind === "email_draft" ? "@" : artifact.kind === "record_change" ? "Δ" : "▤"}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-body font-semibold text-nearblack">{artifact.title}</h4>
              <span className="text-[10px] uppercase tracking-[0.12em] text-charcoal/45">{artifact.status}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-caption leading-5 text-charcoal/65">{artifactSummary(artifact)}</p>
          </div>
          {onTaskAction && artifact.status === "draft" && (
            <div className="flex gap-2 sm:justify-end">
              <button type="button" onClick={() => onTaskAction("reject", artifact.id)} className="min-h-10 border border-[#cbbfad] px-3 text-caption text-charcoal hover:bg-[#eee8de]">Reject</button>
              <button type="button" onClick={() => onTaskAction("approve", artifact.id)} className="min-h-10 bg-nearblack px-3 text-caption font-semibold text-white">Approve</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function AssignmentChat({
  conversationId,
  task,
  agent,
  messages,
  selfParticipant,
  onRefresh,
}: {
  conversationId: string;
  task: AgentTask;
  agent: ConversationParticipant | null;
  messages: ConversationMessage[];
  selfParticipant: ConversationParticipant | null;
  onRefresh: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignmentMessages = useMemo(() => messagesForAgentAssignment(messages, task.id), [messages, task.id]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !agent?.agent_slug || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          source: "text",
          target_agent_slugs: [agent.agent_slug],
          client_message_id: crypto.randomUUID(),
          agent_task_id: task.id,
        }),
      });
      const result = await response.json() as { error?: string; queue_error?: string | null };
      if (!response.ok) throw new Error(result.error ?? "Could not send assignment message");
      setDraft("");
      await onRefresh();
      if (result.queue_error) setError("Message saved, but the agent notification needs retrying.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send assignment message");
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="space-y-3">
        {assignmentMessages.length === 0 && (
          <div className="border-l-2 border-[#9c7c4c] bg-[#eee8de] px-4 py-3">
            <p className="text-caption font-semibold text-nearblack">Assignment brief</p>
            <p className="mt-1 whitespace-pre-wrap text-body leading-6 text-charcoal/70">{task.objective}</p>
            {task.result_summary && <p className="mt-3 border-t border-[#d5cabc] pt-3 text-caption leading-5 text-charcoal/65">Latest result: {task.result_summary}</p>}
          </div>
        )}
        {assignmentMessages.map((message) => {
          const fromSelf = message.author_profile_id === selfParticipant?.id || message.author.is_self;
          return (
            <article key={message.id} className={clsx("max-w-[88%] px-4 py-3 text-body leading-6", fromSelf ? "ml-auto bg-nearblack text-white" : "border-l-2 border-[#9c7c4c] bg-[#eee8de] text-nearblack")}>
              <div className={clsx("mb-1 flex items-baseline justify-between gap-3 text-[10px]", fromSelf ? "text-white/60" : "text-charcoal/50")}>
                <span className="font-semibold">{message.author.display_name}</span>
                <span>{shortDateTime(message.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap">{message.body}</p>
            </article>
          );
        })}
      </div>
      <form onSubmit={send} className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-[#d8cebf] pt-4">
        <label className="sr-only" htmlFor={`assignment-message-${task.id}`}>Message {agent?.display_name ?? "the agent"} about this assignment</label>
        <input
          id={`assignment-message-${task.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={sending || !agent?.agent_slug}
          placeholder={`Message ${agent?.display_name ?? "the agent"} about this assignment…`}
          className="min-h-11 min-w-0 border border-[#cfc6b8] bg-white px-4 text-[16px] text-nearblack outline-none focus:border-nearblack disabled:opacity-50"
        />
        <button disabled={sending || !draft.trim() || !agent?.agent_slug} className="min-h-11 bg-nearblack px-4 text-caption font-semibold text-white disabled:opacity-30">{sending ? "Sending…" : "Send"}</button>
      </form>
      {error && <p role="alert" className="mt-2 text-caption text-red-700">{error}</p>}
    </div>
  );
}

export function AgentOperatingWorkspace({
  conversationId,
  conversationTitle,
  agent,
  tasks,
  messages,
  agentActivity,
  selfParticipant,
  onTaskAction,
  onRefresh,
}: AgentOperatingWorkspaceProps) {
  const firstTask = tasks.find((task) => agentAssignmentView(task) === "active") ?? tasks[0] ?? null;
  const [view, setView] = useState<AgentAssignmentView>(firstTask ? agentAssignmentView(firstTask) : "active");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(firstTask?.id ?? null);
  const [tab, setTab] = useState<AgentAssignmentTab>("chat");
  const filteredTasks = useMemo(() => filterAgentAssignments(tasks, view), [tasks, view]);
  const requestedTask = tasks.find((task) => task.id === selectedTaskId);
  const selectedTask = requestedTask && agentAssignmentView(requestedTask) === view
    ? requestedTask
    : filteredTasks[0] ?? firstTask;

  const chooseView = (nextView: AgentAssignmentView) => {
    setView(nextView);
    const nextTask = filterAgentAssignments(tasks, nextView)[0] ?? null;
    setSelectedTaskId(nextTask?.id ?? null);
    setTab("chat");
  };

  const chooseTask = (task: AgentTask) => {
    setSelectedTaskId(task.id);
    setTab("chat");
  };

  const counts = useMemo(() => ({
    active: filterAgentAssignments(tasks, "active").length,
    waiting: filterAgentAssignments(tasks, "waiting").length,
    done: filterAgentAssignments(tasks, "done").length,
  }), [tasks]);

  if (!selectedTask) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[#f5f1e8] p-6 text-nearblack">
        <p className="label-caps">{agent?.display_name ?? conversationTitle}</p>
        <h3 className="mt-2 font-display text-section">Assignments</h3>
        <div className="mt-8 border-y border-[#d4cbbd] py-10 text-center">
          <p className="text-body text-charcoal/65">No durable assignments yet.</p>
          <p className="mt-2 text-caption text-charcoal/50">Create background work from Chat and it will appear here with progress, evidence and approvals.</p>
        </div>
      </div>
    );
  }

  const computer = latestAgentComputerState(selectedTask);
  const liveActivity = agentActivity.find((activity) => activity.agent_id === selectedTask.owner_agent_id);
  const latestEvents = [...selectedTask.events].slice(-6).reverse();
  const canStop = ["queued", "running", "awaiting_approval"].includes(selectedTask.status);
  const canRetry = selectedTask.status === "failed" && selectedTask.requested_by === selfParticipant?.id && selectedTask.retry_count < 3;
  const currentArtifacts = tab === "evidence"
    ? evidenceArtifacts(selectedTask)
    : tab === "changes"
      ? changeArtifacts(selectedTask)
      : approvalArtifacts(selectedTask);

  return (
    <div className="grid h-full min-h-0 bg-[#f5f1e8] text-nearblack lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="min-h-0 border-b border-[#d4cbbd] bg-[#e8e0d2] lg:border-b-0 lg:border-r">
        <div className="px-4 pb-3 pt-4">
          <div className="flex items-end justify-between gap-3">
            <div><p className="label-caps">{agent?.display_name ?? conversationTitle}</p><h3 className="mt-1 font-display text-section">Assignments</h3></div>
            <span className="flex h-8 min-w-8 items-center justify-center bg-nearblack px-2 text-caption text-white">{tasks.length}</span>
          </div>
          <div className="mt-4 grid grid-cols-3 border border-[#cbbfad]">
            {(Object.keys(VIEW_LABELS) as AgentAssignmentView[]).map((item) => (
              <button key={item} type="button" disabled={counts[item] === 0} onClick={() => chooseView(item)} aria-pressed={view === item} className={clsx("min-h-10 border-r border-[#cbbfad] px-1 text-[11px] last:border-r-0 disabled:cursor-not-allowed disabled:opacity-35", view === item ? "bg-nearblack text-white" : "text-charcoal/65 hover:bg-[#eee8de]")}>
                {VIEW_LABELS[item]} <span className="ml-0.5 opacity-65">{counts[item]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-44 overflow-y-auto border-t border-[#cbbfad] lg:max-h-none lg:min-h-0 lg:flex-1">
          {filteredTasks.length === 0 ? (
            <p className="px-4 py-8 text-center text-caption text-charcoal/50">No {VIEW_LABELS[view].toLowerCase()} assignments.</p>
          ) : filteredTasks.map((task) => (
            <button key={task.id} type="button" onClick={() => chooseTask(task)} aria-current={selectedTask.id === task.id ? "true" : undefined} className={clsx("grid w-full grid-cols-[0.6rem_minmax(0,1fr)] gap-3 border-b border-[#cbbfad] px-4 py-4 text-left", selectedTask.id === task.id ? "bg-[#fffaf1] shadow-[inset_3px_0_0_#9c7c4c]" : "hover:bg-[#eee8de]")}>
              <span aria-hidden className={clsx("mt-1.5 h-2.5 w-2.5", taskStatusDot(task))} />
              <span className="min-w-0">
                <span className="block text-body font-semibold leading-5 text-nearblack">{task.title}</span>
                <span className="mt-1.5 block line-clamp-2 text-caption leading-5 text-charcoal/60">{agentAssignmentStatusLabel(task)}</span>
                <span className="mt-2 block text-[10px] text-charcoal/40">{shortDateTime(assignmentLastUpdatedAt(task))}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-h-0 overflow-y-auto">
        <header className="flex flex-wrap items-start gap-4 border-b border-[#d4cbbd] px-4 py-4 md:px-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center bg-[#c9b184] text-caption font-semibold text-nearblack">{agent?.display_name.slice(0, 2).toUpperCase() ?? "AI"}</div>
          <div className="min-w-0 flex-1">
            <p className="label-caps">{agent?.display_name ?? "Agent"} · {agent?.role_label ?? "Assignment owner"}</p>
            <h3 className="mt-1 font-display text-section leading-tight">{selectedTask.title}</h3>
            <p className="mt-1 text-caption text-charcoal/55">{conversationTitle} · Started {shortDateTime(selectedTask.created_at)}</p>
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-16 md:ml-auto">
            <button type="button" onClick={() => void onRefresh()} className="min-h-11 border border-[#cbbfad] px-3 text-caption hover:bg-[#eee8de]">Refresh</button>
            {canStop && <button type="button" onClick={() => onTaskAction(selectedTask.id, "cancel")} className="min-h-11 border border-[#cbbfad] px-3 text-caption hover:bg-[#eee8de]">Stop work</button>}
            {canRetry && <button type="button" onClick={() => onTaskAction(selectedTask.id, "retry")} className="min-h-11 bg-nearblack px-3 text-caption font-semibold text-white">Retry</button>}
            {computer.controlUrl ? (
              <a href={computer.controlUrl} target="_blank" rel="noreferrer" className="flex min-h-11 items-center bg-nearblack px-3 text-caption font-semibold text-white">Take control</a>
            ) : (
              <button type="button" disabled title="The current runtime has not attached a secure takeover session." className="min-h-11 bg-nearblack px-3 text-caption font-semibold text-white opacity-35">Take control</button>
            )}
          </div>
        </header>

        <div className="p-4 md:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className={clsx("px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white", taskStatusTone(selectedTask))}>{selectedTask.status === "running" ? "Working" : selectedTask.status === "awaiting_approval" ? "Waiting on you" : selectedTask.status.replaceAll("_", " ")}</span>
            <p className="text-caption text-charcoal/65">Outcome: {selectedTask.objective}</p>
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(18rem,1.2fr)_minmax(15rem,0.8fr)]">
            <section>
              <div className="mb-2 flex items-center justify-between gap-3"><p className="label-caps">Live computer</p><span className="text-[10px] uppercase tracking-[0.1em] text-charcoal/45">{computer.controlUrl ? "Takeover ready" : "Observed activity"}</span></div>
              <div className="overflow-hidden border border-[#cbbfad] bg-[#e5ddd0]">
                <div className="flex min-h-10 items-center gap-2 border-b border-[#cbbfad] bg-[#d8d0c4] px-3 text-[10px] text-charcoal/60">
                  <span aria-hidden>● ● ●</span>
                  <span className="min-w-0 flex-1 truncate bg-[#f8f4ec] px-2 py-1.5">{computer.location ?? computer.application ?? computer.tool ?? "RESLU agent runtime"}</span>
                </div>
                {computer.screenshotUrl ? (
                  <div className="relative aspect-[16/10] bg-[#1b1a18]">
                    <Image src={computer.screenshotUrl} alt={`Live computer view for ${selectedTask.title}`} fill unoptimized sizes="(max-width: 1280px) 100vw, 60vw" className="object-contain" />
                  </div>
                ) : (
                  <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
                    <span aria-hidden className="flex h-16 w-16 items-center justify-center border border-[#b9ad9a] bg-[#f2ece2] font-display text-section">{agent?.display_name.slice(0, 2).toUpperCase() ?? "AI"}</span>
                    <p className="mt-4 text-body font-semibold text-nearblack">{liveActivity?.progress_label ?? selectedTask.progress_label ?? "Agent runtime connected"}</p>
                    <p className="mt-2 max-w-md text-caption leading-5 text-charcoal/55">A live screenshot has not been attached to this run. RESLU is showing verified task and tool activity rather than inventing a computer view.</p>
                  </div>
                )}
                <div className="flex flex-wrap justify-between gap-2 border-t border-[#cbbfad] px-3 py-2 text-[10px] text-charcoal/55">
                  <span>{selectedTask.progress_label ?? latestEvents[0]?.label ?? "Waiting for the next runtime event"}</span>
                  <span>{computer.tool ? `Tool: ${computer.tool}` : "Session activity is recoverable"}</span>
                </div>
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3"><p className="label-caps">Live activity</p><span className="text-[10px] text-charcoal/45">{latestEvents.length} recent events</span></div>
              <div className="border-t border-[#d4cbbd]">
                {latestEvents.length === 0 ? (
                  <p className="py-8 text-center text-caption text-charcoal/50">The assignment is waiting for its first runtime event.</p>
                ) : latestEvents.map((event, index) => (
                  <div key={event.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3 border-b border-[#d4cbbd] py-3">
                    <span aria-hidden className={clsx("mt-1 h-2.5 w-2.5", index === 0 && selectedTask.status === "running" ? "bg-[#9c7c4c]" : "bg-[#355e4b]")} />
                    <div>
                      <div className="flex items-baseline justify-between gap-3"><p className="text-caption font-semibold text-nearblack">{event.label}</p><span className="shrink-0 text-[10px] text-charcoal/40">{shortDateTime(event.created_at)}</span></div>
                      {event.detail && <p className="mt-1 text-caption leading-5 text-charcoal/55">{event.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <nav className="mt-6 flex border-y border-[#d4cbbd]" role="tablist" aria-label="Assignment workspace">
            {(Object.keys(TAB_LABELS) as AgentAssignmentTab[]).map((item) => {
              const count = item === "evidence" ? evidenceArtifacts(selectedTask).length : item === "changes" ? changeArtifacts(selectedTask).length : item === "approvals" ? approvalArtifacts(selectedTask).length : null;
              return <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={clsx("min-h-11 flex-1 border-b-2 px-1 text-[11px] sm:px-3 sm:text-caption", tab === item ? "border-[#9c7c4c] text-nearblack" : "border-transparent text-charcoal/55 hover:bg-[#eee8de]")}>{TAB_LABELS[item]}{count != null && count > 0 ? ` ${count}` : ""}</button>;
            })}
          </nav>

          <div className="py-5">
            {tab === "chat" && <AssignmentChat conversationId={conversationId} task={selectedTask} agent={agent} messages={messages} selfParticipant={selfParticipant} onRefresh={onRefresh} />}
            {tab === "activity" && (
              <div className="divide-y divide-[#d8cebf] border-y border-[#d8cebf]">
                {[...selectedTask.events].reverse().map((event) => (
                  <article key={event.id} className="grid gap-2 py-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <p className="text-[10px] uppercase tracking-[0.1em] text-charcoal/45">{shortDateTime(event.created_at)}<br />{event.event_type.replaceAll("_", " ")}</p>
                    <div><h4 className="text-body font-semibold text-nearblack">{event.label}</h4>{event.detail && <p className="mt-1 whitespace-pre-wrap text-caption leading-5 text-charcoal/60">{event.detail}</p>}</div>
                  </article>
                ))}
                {selectedTask.events.length === 0 && <p className="py-8 text-center text-caption text-charcoal/50">No activity has been recorded yet.</p>}
              </div>
            )}
            {tab === "evidence" && <ArtifactRows artifacts={currentArtifacts} empty="No evidence has been attached to this assignment yet." />}
            {tab === "changes" && <ArtifactRows artifacts={currentArtifacts} empty="No proposed or completed changes have been recorded yet." />}
            {tab === "approvals" && <ArtifactRows artifacts={currentArtifacts} empty="Nothing needs your approval." onTaskAction={(action, artifactId) => onTaskAction(selectedTask.id, action, artifactId)} />}
          </div>
        </div>
      </section>
    </div>
  );
}
