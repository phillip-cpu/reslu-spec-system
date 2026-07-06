"use client";

import { useState } from "react";
import clsx from "clsx";
import { isTaskOverdue, phaseProgress } from "@/lib/design-framework";
import type { DesignAssigneeSummary, DesignPhaseStatus, DesignPhaseWithTasks, DesignTaskWithAssignees } from "@/types/phase-12b";

const STATUS_LABEL: Record<DesignPhaseStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
  na: "N/A",
};

// Cycle order for the status control's click-to-cycle interaction —
// mirrors DocumentStatusLight's own free cycle (no state-machine guard).
const STATUS_CYCLE: DesignPhaseStatus[] = ["not_started", "in_progress", "complete", "na"];

const STATUS_DOT_CLASS: Record<DesignPhaseStatus, string> = {
  not_started: "bg-charcoal/20",
  in_progress: "bg-sand",
  complete: "bg-nearblack",
  na: "border border-charcoal/30 bg-transparent",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * One phase's vertical section — BUILD-SPEC.md task brief: "vertical
 * phase sections (consistent with the new vertical-board pattern) —
 * each phase: status control (not started / in progress / complete /
 * N/A cycle or select), task list (title, multi-assignees with
 * auto-assign creator, due date red-overdue, tick complete), add-task
 * composer, phase progress chip (3/5 tasks)."
 *
 * A plain <select> is used for the status control rather than a
 * click-to-cycle button (the brief offers both — "cycle or select") —
 * a select is simpler to build correctly and unambiguous for a 4-value
 * enum, avoiding a click-to-cycle's usual "which order do the 4 states
 * go in" surprise for a first-time user.
 */
export function DesignPhaseSection({
  phase,
  team,
  currentUserId,
  onStatusChange,
  onAddTask,
  onPatchTask,
  onDeleteTask,
}: {
  phase: DesignPhaseWithTasks;
  team: DesignAssigneeSummary[];
  currentUserId: string;
  onStatusChange: (status: DesignPhaseStatus) => void;
  onAddTask: (title: string, assigneeIds: string[], dueDate: string | null) => void;
  onPatchTask: (
    task: DesignTaskWithAssignees,
    patch: Record<string, unknown>,
    refUpdate?: Partial<DesignTaskWithAssignees>
  ) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  const [composing, setComposing] = useState(false);
  const progress = phaseProgress(phase);
  const teamById = new Map(team.map((t) => [t.id, t]));

  return (
    <div className="border border-[#dcd6cc]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dcd6cc] bg-offwhite px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", STATUS_DOT_CLASS[phase.status])} />
          <span className="label-caps !text-nearblack">{phase.name}</span>
          {progress.total_count > 0 && (
            <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
              {progress.done_count}/{progress.total_count}
            </span>
          )}
        </div>
        <select
          value={phase.status}
          onChange={(e) => onStatusChange(e.target.value as DesignPhaseStatus)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption text-nearblack focus:border-nearblack focus:outline-none"
        >
          {STATUS_CYCLE.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="p-3">
        {phase.tasks.length === 0 ? (
          <p className="px-1 py-2 text-caption text-charcoal/40">No tasks yet.</p>
        ) : (
          <div className="divide-y divide-[#e5e0d6]">
            {phase.tasks.map((task) => (
              <DesignTaskRow
                key={task.id}
                task={task}
                team={team}
                teamById={teamById}
                onPatch={(patch, refUpdate) => onPatchTask(task, patch, refUpdate)}
                onDelete={() => onDeleteTask(task.id)}
              />
            ))}
          </div>
        )}

        <div className="mt-2 border-t border-[#e5e0d6] pt-2">
          {composing ? (
            <DesignTaskComposer
              team={team}
              currentUserId={currentUserId}
              onSubmit={(title, assigneeIds, dueDate) => {
                onAddTask(title, assigneeIds, dueDate);
                setComposing(false);
              }}
              onCancel={() => setComposing(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setComposing(true)}
              className="w-full px-1 py-1.5 text-left text-caption text-charcoal/50 hover:bg-nearwhite hover:text-nearblack"
            >
              + Add task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DesignTaskRow({
  task,
  team,
  teamById,
  onPatch,
  onDelete,
}: {
  task: DesignTaskWithAssignees;
  team: DesignAssigneeSummary[];
  teamById: Map<string, DesignAssigneeSummary>;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<DesignTaskWithAssignees>) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const isDone = !!task.completed_at;
  const overdue = isTaskOverdue(task.due_date, task.completed_at);

  function toggleAssignee(id: string) {
    const current = task.assignees.map((a) => a.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onPatch(
      { assignee_ids: next },
      { assignees: next.map((x) => teamById.get(x)).filter((p): p is DesignAssigneeSummary => !!p) }
    );
  }

  return (
    <div id={`focus-design_task-${task.id}`} className={clsx("px-1 py-2", isDone && "opacity-60")}>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={isDone}
          onChange={(e) => onPatch({ complete: e.target.checked })}
          className="h-4 w-4 shrink-0"
        />
        <button type="button" onClick={() => setExpanded((e) => !e)} className="min-w-0 flex-1 text-left">
          <span className={clsx("text-body", isDone ? "text-charcoal/50 line-through" : "text-nearblack")}>
            {task.title}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {task.due_date && (
            <span className={clsx("text-caption", overdue ? "text-red-700" : "text-charcoal/50")}>
              {overdue ? "⚠ " : ""}
              {new Date(task.due_date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
            </span>
          )}
          <AssigneeStack assignees={task.assignees} />
        </div>
      </div>

      {expanded && (
        <div className="mt-2 ml-7 space-y-2.5 border-t border-[#e5e0d6] pt-2.5">
          <textarea
            defaultValue={task.description ?? ""}
            placeholder="Notes / description"
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== task.description) onPatch({ description: v });
            }}
            rows={2}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="date"
              defaultValue={task.due_date ?? ""}
              onBlur={(e) => {
                const v = e.target.value || null;
                if (v !== task.due_date) onPatch({ due_date: v });
              }}
              className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setAssigneePickerOpen((o) => !o)}
              className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal hover:border-nearblack"
            >
              Assignees
            </button>
            <button type="button" onClick={onDelete} className="text-caption text-red-700/70 hover:text-red-700">
              Remove
            </button>
          </div>
          {assigneePickerOpen && (
            <div className="flex flex-wrap gap-2 border border-[#e5e0d6] bg-white px-2 py-1.5">
              {team.map((t) => (
                <label key={t.id} className="flex items-center gap-1 text-caption text-charcoal/70">
                  <input
                    type="checkbox"
                    checked={task.assignees.some((a) => a.id === t.id)}
                    onChange={() => toggleAssignee(t.id)}
                    className="h-3 w-3"
                  />
                  {t.full_name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DesignTaskComposer({
  team,
  currentUserId,
  onSubmit,
  onCancel,
}: {
  team: DesignAssigneeSummary[];
  currentUserId: string;
  onSubmit: (title: string, assigneeIds: string[], dueDate: string | null) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeIds, setAssigneeIds] = useState<string[]>(currentUserId ? [currentUserId] : []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit(title.trim(), assigneeIds, dueDate || null);
    setTitle("");
    setDueDate("");
    setAssigneeIds(currentUserId ? [currentUserId] : []);
  }

  return (
    <form onSubmit={submit} className="space-y-2 border border-[#c9c2b4] bg-nearwhite p-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Task title"
        className="w-full border-none bg-transparent px-1 py-1 text-body focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="border border-[#c9c2b4] bg-white px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-2 border border-[#e5e0d6] bg-white px-2 py-1.5">
        {team.map((t) => {
          const checked = assigneeIds.includes(t.id);
          return (
            <label key={t.id} className="flex items-center gap-1 text-caption text-charcoal/70">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  if (e.target.checked) setAssigneeIds((cur) => [...cur, t.id]);
                  else setAssigneeIds((cur) => cur.filter((id) => id !== t.id));
                }}
                className="h-3 w-3"
              />
              {t.full_name}
            </label>
          );
        })}
      </div>
      <div className="flex gap-2">
        <button type="submit" className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">
          Add
        </button>
        <button type="button" onClick={onCancel} className="text-caption text-charcoal/50 hover:text-nearblack">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AssigneeStack({ assignees }: { assignees: DesignAssigneeSummary[] }) {
  if (assignees.length === 0) return null;
  return (
    <div className="flex -space-x-1.5">
      {assignees.map((a) => (
        <span
          key={a.id}
          title={a.full_name}
          className="flex h-5 w-5 items-center justify-center border border-sand bg-cream text-caption !text-sand"
        >
          {initials(a.full_name)}
        </span>
      ))}
    </div>
  );
}
