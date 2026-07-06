"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import type {
  OfficeAssigneeSummary,
  OfficeGroupWithTasks,
  OfficeSubtask,
  OfficeTaskWithRefs,
} from "@/types/phase-13";
import { OFFICE_ARCHIVED_GROUP_NAME } from "@/types/phase-13";

interface Props {
  initialGroups: OfficeGroupWithTasks[];
  team: OfficeAssigneeSummary[];
  currentUserId: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isPastDue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate + "T00:00:00") < today;
}

/**
 * Office board (Phase 13) — BUILD-SPEC.md §"13 Office" /
 * docs/OFFICE-BRIEF.md. A GLOBAL Monday-style grouped list (reusing the
 * "grouped list" visual/interaction patterns from ProjectBoard's
 * GroupTable/GroupRows — compact per-department table, expandable rows,
 * inline pickers — WITHOUT importing anything from that per-project
 * component, since this board has no project_id/columns/phase_group_id
 * concept at all). Each office_groups row is a department (Marketing,
 * Website, Meta Ads, Google Ads, Operations, Systems & Tech, Phillip,
 * Archived); each office_tasks row is either a normal completable card
 * (kind 'task') or a pinned, un-completable standing rule card (kind
 * 'rule' — e.g. "DO NOT enable Google AI Max").
 *
 * Complete -> Archive: ticking a task's checkbox calls PATCH
 * .../tasks/[id] with { complete: true }, which the API moves into the
 * Archived group server-side (see that route's doc comment) — this
 * component reflects the move by re-slotting the task into the
 * Archived group bucket locally, same "targeted re-slot rather than a
 * full reload" approach ProjectBoard's phase_group_id patch uses.
 *
 * The Archived group renders collapsed by default (BUILD-SPEC.md "13
 * Office" point 2) — a simple client-side toggle, not a separate route.
 */
export function OfficeBoard({ initialGroups, team, currentUserId }: Props) {
  const [groups, setGroups] = useState<OfficeGroupWithTasks[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(initialGroups.filter((g) => g.name === OFFICE_ARCHIVED_GROUP_NAME).map((g) => g.id))
  );

  const teamById = useMemo(() => new Map(team.map((t) => [t.id, t])), [team]);

  function toggleCollapsed(groupId: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function addTask(
    groupId: string,
    title: string,
    kind: "task" | "rule",
    assigneeIds: string[]
  ) {
    setError(null);
    try {
      const res = await fetch("/api/office/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId, title, kind, assignee_ids: assigneeIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add card.");
      const { task } = await res.json();
      setGroups((cur) => cur.map((g) => (g.id === groupId ? { ...g, tasks: [...g.tasks, task] } : g)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add card.");
    }
  }

  async function patchTask(task: OfficeTaskWithRefs, patch: Record<string, unknown>) {
    const res = await fetch(`/api/office/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Could not update card.");
    const { task: updated } = await res.json();
    return updated;
  }

  function applyTaskPatch(taskId: string, patch: Partial<OfficeTaskWithRefs>) {
    setGroups((cur) => cur.map((g) => ({ ...g, tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) })));
  }

  async function updateTask(
    task: OfficeTaskWithRefs,
    patch: Record<string, unknown>,
    refUpdate?: Partial<OfficeTaskWithRefs>
  ) {
    const prev = groups;
    // Optimistic UI patch — only applied for plain field edits
    // (refUpdate or a patch whose keys are real OfficeTaskWithRefs
    // fields, e.g. title/description/due_date). The `complete` action
    // below intentionally skips this optimistic step and waits for the
    // server's real response instead, since `complete` isn't itself a
    // field on the task and the archive-move re-slot needs the actual
    // returned group_id anyway.
    if (refUpdate) {
      applyTaskPatch(task.id, refUpdate);
    } else if (!("complete" in patch)) {
      applyTaskPatch(task.id, patch as Partial<OfficeTaskWithRefs>);
    }
    setError(null);
    try {
      const updated = await patchTask(task, patch);
      // group_id may have changed (a plain move, or a complete-action
      // archive-move done server-side) — re-slot into the right bucket.
      if (updated.group_id !== task.group_id) {
        setGroups((cur) => {
          const without = cur.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== task.id) }));
          return without.map((g) =>
            g.id === updated.group_id
              ? { ...g, tasks: [...g.tasks, { ...task, ...updated, ...refUpdate }] }
              : g
          );
        });
      } else {
        applyTaskPatch(task.id, { ...updated, ...refUpdate });
      }
    } catch (err) {
      setGroups(prev);
      setError(err instanceof Error ? err.message : "Could not update card.");
    }
  }

  async function completeTask(task: OfficeTaskWithRefs, complete: boolean) {
    await updateTask(task, { complete });
  }

  async function deleteTask(task: OfficeTaskWithRefs) {
    if (!confirm(`Remove "${task.title}"?`)) return;
    const prev = groups;
    setGroups((cur) => cur.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== task.id) })));
    const res = await fetch(`/api/office/tasks/${task.id}`, { method: "DELETE" });
    if (!res.ok) {
      setGroups(prev);
      setError("Could not remove card.");
    }
  }

  async function addSubtask(task: OfficeTaskWithRefs, title: string) {
    setError(null);
    try {
      const res = await fetch("/api/office/subtasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: task.id, title }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add subtask.");
      const { subtask } = await res.json();
      applyTaskPatch(task.id, { subtasks: [...task.subtasks, subtask] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add subtask.");
    }
  }

  async function toggleSubtask(task: OfficeTaskWithRefs, subtask: OfficeSubtask) {
    const prevSubtasks = task.subtasks;
    const nextSubtasks = task.subtasks.map((s) => (s.id === subtask.id ? { ...s, done: !s.done } : s));
    applyTaskPatch(task.id, { subtasks: nextSubtasks });
    const res = await fetch(`/api/office/subtasks/${subtask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !subtask.done }),
    });
    if (!res.ok) {
      applyTaskPatch(task.id, { subtasks: prevSubtasks });
      setError("Could not update subtask.");
    }
  }

  async function addGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/office/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add group.");
      const { group } = await res.json();
      setGroups((cur) => [...cur, { ...group, tasks: [] }]);
      setNewGroupName("");
      setAddingGroup(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add group.");
    }
  }

  async function renameGroup(groupId: string, name: string) {
    const prev = groups;
    setGroups((cur) => cur.map((g) => (g.id === groupId ? { ...g, name } : g)));
    const res = await fetch(`/api/office/groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setGroups(prev);
      setError((await res.json()).error ?? "Could not rename group.");
    }
  }

  async function deleteGroup(groupId: string, name: string) {
    if (!confirm(`Delete group "${name}"?`)) return;
    const prev = groups;
    setGroups((cur) => cur.filter((g) => g.id !== groupId));
    const res = await fetch(`/api/office/groups/${groupId}`, { method: "DELETE" });
    if (!res.ok) {
      setGroups(prev);
      setError((await res.json()).error ?? "Could not delete group.");
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      {groups.map((group) => {
        const isArchived = group.name === OFFICE_ARCHIVED_GROUP_NAME;
        const isCollapsed = collapsed.has(group.id);
        return (
          <GroupTable
            key={group.id}
            group={group}
            team={team}
            teamById={teamById}
            currentUserId={currentUserId}
            isArchived={isArchived}
            isCollapsed={isCollapsed}
            onToggleCollapsed={() => toggleCollapsed(group.id)}
            onRename={isArchived ? undefined : (name) => renameGroup(group.id, name)}
            onDelete={isArchived ? undefined : () => deleteGroup(group.id, group.name)}
            onAddTask={(title, kind, assigneeIds) => addTask(group.id, title, kind, assigneeIds)}
            onCompleteTask={completeTask}
            onPatchTask={updateTask}
            onDeleteTask={deleteTask}
            onAddSubtask={addSubtask}
            onToggleSubtask={toggleSubtask}
          />
        );
      })}

      {addingGroup ? (
        <form onSubmit={addGroup} className="flex max-w-sm gap-2">
          <input
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Department name"
            className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
          <button type="submit" className="bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal">
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAddingGroup(false);
              setNewGroupName("");
            }}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAddingGroup(true)}
          className="border border-dashed border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal/60 transition-colors hover:border-nearblack hover:text-nearblack"
        >
          + Add department
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Group table (one department)
// ------------------------------------------------------------

function GroupTable({
  group,
  team,
  teamById,
  currentUserId,
  isArchived,
  isCollapsed,
  onToggleCollapsed,
  onRename,
  onDelete,
  onAddTask,
  onCompleteTask,
  onPatchTask,
  onDeleteTask,
  onAddSubtask,
  onToggleSubtask,
}: {
  group: OfficeGroupWithTasks;
  team: OfficeAssigneeSummary[];
  teamById: Map<string, OfficeAssigneeSummary>;
  currentUserId: string;
  isArchived: boolean;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  onAddTask: (title: string, kind: "task" | "rule", assigneeIds: string[]) => void;
  onCompleteTask: (task: OfficeTaskWithRefs, complete: boolean) => void;
  onPatchTask: (task: OfficeTaskWithRefs, patch: Record<string, unknown>, refUpdate?: Partial<OfficeTaskWithRefs>) => void;
  onDeleteTask: (task: OfficeTaskWithRefs) => void;
  onAddSubtask: (task: OfficeTaskWithRefs, title: string) => void;
  onToggleSubtask: (task: OfficeTaskWithRefs, subtask: OfficeSubtask) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [composing, setComposing] = useState(false);

  const ruleCards = group.tasks.filter((t) => t.kind === "rule");
  const normalTasks = group.tasks.filter((t) => t.kind !== "rule");

  return (
    <div className="border border-[#dcd6cc]">
      <div className="flex items-center justify-between gap-2 border-b border-[#dcd6cc] bg-offwhite px-3 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex items-center gap-2 text-left"
        >
          <span className="text-caption text-charcoal/40">{isCollapsed ? "▸" : "▾"}</span>
          {renaming && onRename ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => {
                setRenaming(false);
                if (nameDraft.trim() && nameDraft.trim() !== group.name) onRename(nameDraft.trim());
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="border border-nearblack bg-nearwhite px-2 py-1 text-subhead text-nearblack focus:outline-none"
            />
          ) : (
            <span
              onClick={(e) => {
                if (!onRename) return;
                e.stopPropagation();
                setNameDraft(group.name);
                setRenaming(true);
              }}
              className={clsx("label-caps !text-nearblack", onRename && "hover:!text-sand")}
            >
              {group.name} · {normalTasks.length}
            </span>
          )}
        </button>
        {onDelete && (
          <button type="button" onClick={onDelete} className="text-caption text-charcoal/40 hover:text-red-700">
            ✕
          </button>
        )}
      </div>

      {!isCollapsed && (
        <>
          {ruleCards.length > 0 && (
            <div className="divide-y divide-[#e5e0d6] border-b border-[#e5e0d6]">
              {ruleCards.map((task) => (
                <RuleCardRow key={task.id} task={task} onDelete={() => onDeleteTask(task)} />
              ))}
            </div>
          )}

          {normalTasks.length === 0 ? (
            <p className="px-3 py-3 text-caption text-charcoal/40">No cards yet.</p>
          ) : (
            <div className="divide-y divide-[#e5e0d6]">
              {normalTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  team={team}
                  teamById={teamById}
                  isArchived={isArchived}
                  onComplete={(complete) => onCompleteTask(task, complete)}
                  onPatch={(patch, refUpdate) => onPatchTask(task, patch, refUpdate)}
                  onDelete={() => onDeleteTask(task)}
                  onAddSubtask={(title) => onAddSubtask(task, title)}
                  onToggleSubtask={(subtask) => onToggleSubtask(task, subtask)}
                />
              ))}
            </div>
          )}

          <div className="border-t border-[#e5e0d6] p-2">
            {composing ? (
              <TaskComposer
                team={team}
                currentUserId={currentUserId}
                onSubmit={(title, kind, assigneeIds) => {
                  onAddTask(title, kind, assigneeIds);
                  setComposing(false);
                }}
                onCancel={() => setComposing(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="w-full px-2 py-1.5 text-left text-caption text-charcoal/50 hover:bg-nearwhite hover:text-nearblack"
              >
                + Add card
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Standing rule card — sand left border, no checkbox, no due date,
// un-completable. BUILD-SPEC.md §"13 Office" point 2.
// ------------------------------------------------------------

function RuleCardRow({ task, onDelete }: { task: OfficeTaskWithRefs; onDelete: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 border-l-4 border-sand bg-cream px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="label-caps !text-sand">Standing rule</span>
        </div>
        <p className="mt-0.5 text-body text-nearblack">{task.title}</p>
        {task.description && <p className="mt-1 text-caption text-charcoal/60">{task.description}</p>}
      </div>
      <button type="button" onClick={onDelete} className="shrink-0 text-caption text-charcoal/30 hover:text-red-700">
        ✕
      </button>
    </div>
  );
}

// ------------------------------------------------------------
// Normal task row (expandable)
// ------------------------------------------------------------

function TaskRow({
  task,
  team,
  teamById,
  isArchived,
  onComplete,
  onPatch,
  onDelete,
  onAddSubtask,
  onToggleSubtask,
}: {
  task: OfficeTaskWithRefs;
  team: OfficeAssigneeSummary[];
  teamById: Map<string, OfficeAssigneeSummary>;
  isArchived: boolean;
  onComplete: (complete: boolean) => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<OfficeTaskWithRefs>) => void;
  onDelete: () => void;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (subtask: OfficeSubtask) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);

  const pastDue = isPastDue(task.due_date);
  const isDone = !!task.completed_at;
  const doneCount = task.subtasks.filter((s) => s.done).length;

  function toggleAssignee(id: string) {
    const current = task.assignees.map((a) => a.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onPatch(
      { assignee_ids: next },
      { assignees: next.map((x) => teamById.get(x)).filter((p): p is OfficeAssigneeSummary => !!p) }
    );
  }

  function submitSubtask(e: React.FormEvent) {
    e.preventDefault();
    if (!newSubtaskTitle.trim()) return;
    onAddSubtask(newSubtaskTitle.trim());
    setNewSubtaskTitle("");
  }

  return (
    <div id={`focus-office_task-${task.id}`} className={clsx("px-3 py-2.5", isDone && "opacity-60")}>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={isDone}
          onChange={(e) => onComplete(e.target.checked)}
          title={isDone ? "Uncomplete (restores original group)" : "Complete (moves to Archived)"}
          className="h-4 w-4 shrink-0"
        />
        <button type="button" onClick={() => setExpanded((e) => !e)} className="min-w-0 flex-1 text-left">
          <span className={clsx("text-body", isDone ? "text-charcoal/50 line-through" : "text-nearblack")}>
            {task.title}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {task.subtasks.length > 0 && (
            <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
              {doneCount}/{task.subtasks.length}
            </span>
          )}
          {task.due_date && (
            <span className={clsx("text-caption", pastDue && !isDone ? "text-red-700" : "text-charcoal/50")}>
              {pastDue && !isDone ? "⚠ " : ""}
              {new Date(task.due_date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
            </span>
          )}
          <AssigneeStack assignees={task.assignees} />
        </div>
      </div>

      {expanded && (
        <div className="mt-2.5 ml-7 space-y-3 border-t border-[#e5e0d6] pt-2.5">
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
            {isArchived && (
              <span className="label-caps !text-charcoal/35">Archived {task.completed_at ? "· completed" : ""}</span>
            )}
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

          <div>
            <p className="label-caps mb-1.5 !text-sand">Subtasks</p>
            <ul className="space-y-1">
              {task.subtasks.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={s.done}
                    onChange={() => onToggleSubtask(s)}
                    className="h-3 w-3"
                  />
                  <span className={clsx("text-caption", s.done ? "text-charcoal/40 line-through" : "text-charcoal/80")}>
                    {s.title}
                  </span>
                </li>
              ))}
            </ul>
            <form onSubmit={submitSubtask} className="mt-1.5 flex gap-2">
              <input
                value={newSubtaskTitle}
                onChange={(e) => setNewSubtaskTitle(e.target.value)}
                placeholder="Add subtask"
                className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
              />
              <button type="submit" className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">
                Add
              </button>
            </form>
          </div>

          <button type="button" onClick={onDelete} className="text-caption text-red-700/70 hover:text-red-700">
            Remove card
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Add-task composer — title, kind (task/rule), assignee picker
// (auto-assign creator pre-checked, mirrors ProjectBoard's
// AssigneeMultiPicker).
// ------------------------------------------------------------

function TaskComposer({
  team,
  currentUserId,
  onSubmit,
  onCancel,
}: {
  team: OfficeAssigneeSummary[];
  currentUserId: string;
  onSubmit: (title: string, kind: "task" | "rule", assigneeIds: string[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"task" | "rule">("task");
  const [assigneeIds, setAssigneeIds] = useState<string[]>(currentUserId ? [currentUserId] : []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit(title.trim(), kind, assigneeIds);
    setTitle("");
    setKind("task");
    setAssigneeIds(currentUserId ? [currentUserId] : []);
  }

  return (
    <form onSubmit={submit} className="space-y-2 border border-[#c9c2b4] bg-nearwhite p-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Card title"
        className="w-full border-none bg-transparent px-1 py-1 text-body focus:outline-none"
      />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-caption text-charcoal/70">
          <input type="radio" checked={kind === "task"} onChange={() => setKind("task")} />
          Task
        </label>
        <label className="flex items-center gap-1.5 text-caption text-charcoal/70">
          <input type="radio" checked={kind === "rule"} onChange={() => setKind("rule")} />
          Standing rule
        </label>
      </div>
      {kind === "task" && (
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
      )}
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

function AssigneeStack({ assignees }: { assignees: OfficeAssigneeSummary[] }) {
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
