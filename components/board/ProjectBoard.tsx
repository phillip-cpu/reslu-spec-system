"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type {
  AssigneeSummary,
  BoardColumnWithAssigneeTasks,
  BoardGroupWithTasks,
  BoardTaskWithAssignees,
} from "@/types/phase-12a-b";
import type { Contact } from "@/types";

interface Props {
  projectId: string;
  initialColumns: BoardColumnWithAssigneeTasks[];
  initialGroups: BoardGroupWithTasks[];
  team: AssigneeSummary[];
  currentUserId: string;
}

const SORT_STEP = 1000;

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
 * Project board — Board v2 (BUILD-SPEC.md §"Board v2"). Two view
 * modes toggled at the top:
 *   - Kanban (unchanged mechanics from Week 9: columns side-by-side,
 *     native HTML5 drag-drop between columns, per-column add-card
 *     composer, rename/delete columns) — now with multi-assignee
 *     stacked-initials chips instead of a single assignee circle.
 *   - Grouped list (Monday-style): vertical phase groups
 *     (board_groups, lazily seeded from the default template on first
 *     visit to THIS view), each a compact table (title, assignees,
 *     contact, due, status chip). A card's phase_group_id and
 *     column_id are independent — this view edits phase_group_id via a
 *     per-row picker and shows (but does not drag-drop move) the
 *     status column as a read-only chip; Kanban remains the surface for
 *     moving cards between statuses.
 *
 * Auto-assign on create: a new card is assigned to `currentUserId`
 * automatically unless the composer's assignee picker is used to
 * override before submitting (BUILD-SPEC.md "Board v2" point 1).
 */
export function ProjectBoard({ projectId, initialColumns, initialGroups, team, currentUserId }: Props) {
  const [view, setView] = useState<"kanban" | "grouped">("kanban");
  const [columns, setColumns] = useState<BoardColumnWithAssigneeTasks[]>(initialColumns);
  const [groups, setGroups] = useState<BoardGroupWithTasks[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [groupsSeeded, setGroupsSeeded] = useState(initialGroups.length > 0);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const teamById = useMemo(() => new Map(team.map((t) => [t.id, t])), [team]);
  const columnById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  // Every non-deleted task, flat, for a quick lookup shared by both views.
  const allTasks = useMemo(() => columns.flatMap((c) => c.tasks), [columns]);

  async function switchToGrouped() {
    setView("grouped");
    if (!groupsSeeded) {
      try {
        const res = await fetch(`/api/projects/${projectId}/board/groups/seed`, { method: "POST" });
        if (res.ok) {
          const { groups: seeded } = await res.json();
          setGroups(seeded.map((g: BoardGroupWithTasks) => ({ ...g, tasks: [] })));
        }
      } catch {
        // Non-fatal — the grouped view still renders with an
        // "Ungrouped" bucket if seeding fails.
      } finally {
        setGroupsSeeded(true);
      }
    }
  }

  async function addColumn(e: React.FormEvent) {
    e.preventDefault();
    if (!newColumnName.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board/columns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newColumnName.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add column.");
      const { column } = await res.json();
      setColumns((cur) => [...cur, { ...column, tasks: [] }]);
      setNewColumnName("");
      setAddingColumn(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add column.");
    }
  }

  async function renameColumn(columnId: string, name: string) {
    const prev = columns;
    setColumns((cur) => cur.map((c) => (c.id === columnId ? { ...c, name } : c)));
    const res = await fetch(`/api/board-columns/${columnId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setColumns(prev);
      setError((await res.json()).error ?? "Could not rename column.");
    }
  }

  async function deleteColumn(columnId: string, name: string) {
    const column = columns.find((c) => c.id === columnId);
    if (column && column.tasks.length > 0) {
      setError("This column still has cards — move or remove them first.");
      return;
    }
    if (!confirm(`Delete column "${name}"?`)) return;
    const prev = columns;
    setColumns((cur) => cur.filter((c) => c.id !== columnId));
    const res = await fetch(`/api/board-columns/${columnId}`, { method: "DELETE" });
    if (!res.ok) {
      setColumns(prev);
      setError((await res.json()).error ?? "Could not delete column.");
    }
  }

  async function addTask(columnId: string, title: string, assigneeIds: string[]) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ column_id: columnId, title, assignee_ids: assigneeIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add card.");
      const { task } = await res.json();
      const assignees = assigneeIds.map((id) => teamById.get(id)).filter((p): p is AssigneeSummary => !!p);
      const withRefs: BoardTaskWithAssignees = { ...task, assignees, contact: null };
      setColumns((cur) =>
        cur.map((c) => (c.id === columnId ? { ...c, tasks: [...c.tasks, withRefs] } : c))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add card.");
    }
  }

  async function patchTask(task: BoardTaskWithAssignees, patch: Record<string, unknown>) {
    const res = await fetch(`/api/board-tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Could not update card.");
    const { task: updated } = await res.json();
    return updated;
  }

  function applyTaskPatch(taskId: string, patch: Partial<BoardTaskWithAssignees>) {
    setColumns((cur) =>
      cur.map((c) => ({ ...c, tasks: c.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) }))
    );
    setGroups((cur) =>
      cur.map((g) => ({ ...g, tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) }))
    );
  }

  async function updateTaskField(
    task: BoardTaskWithAssignees,
    patch: Record<string, unknown>,
    refUpdate: Partial<BoardTaskWithAssignees>
  ) {
    const prevColumns = columns;
    const prevGroups = groups;
    applyTaskPatch(task.id, { ...patch, ...refUpdate } as Partial<BoardTaskWithAssignees>);
    setError(null);
    try {
      await patchTask(task, patch);
      // A phase_group_id change moves the task between group buckets —
      // simplest correct approach is a targeted re-slot rather than a
      // full reload.
      if ("phase_group_id" in patch) {
        setGroups((cur) => {
          const withoutTask = cur.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== task.id) }));
          const targetGroupId = patch.phase_group_id as string | null;
          if (!targetGroupId) return withoutTask;
          return withoutTask.map((g) =>
            g.id === targetGroupId ? { ...g, tasks: [...g.tasks, { ...task, ...patch, ...refUpdate }] } : g
          );
        });
      }
    } catch (err) {
      setColumns(prevColumns);
      setGroups(prevGroups);
      setError(err instanceof Error ? err.message : "Could not update card.");
    }
  }

  async function deleteTask(task: BoardTaskWithAssignees) {
    if (!confirm(`Remove card "${task.title}"?`)) return;
    const prevColumns = columns;
    const prevGroups = groups;
    setColumns((cur) => cur.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== task.id) })));
    setGroups((cur) => cur.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== task.id) })));
    const res = await fetch(`/api/board-tasks/${task.id}`, { method: "DELETE" });
    if (!res.ok) {
      setColumns(prevColumns);
      setGroups(prevGroups);
      setError("Could not remove card.");
    }
  }

  async function addGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add phase group.");
      const { group } = await res.json();
      setGroups((cur) => [...cur, { ...group, tasks: [] }]);
      setNewGroupName("");
      setAddingGroup(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add phase group.");
    }
  }

  async function renameGroup(groupId: string, name: string) {
    const prev = groups;
    setGroups((cur) => cur.map((g) => (g.id === groupId ? { ...g, name } : g)));
    const res = await fetch(`/api/board-groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setGroups(prev);
      setError((await res.json()).error ?? "Could not rename phase group.");
    }
  }

  async function deleteGroup(groupId: string, name: string) {
    if (!confirm(`Delete phase group "${name}"? Cards keep their status column but lose this phase label.`)) return;
    const prev = groups;
    setGroups((cur) => cur.filter((g) => g.id !== groupId));
    const res = await fetch(`/api/board-groups/${groupId}`, { method: "DELETE" });
    if (!res.ok) {
      setGroups(prev);
      setError((await res.json()).error ?? "Could not delete phase group.");
    } else {
      // Cards in the deleted group become ungrouped locally too (the DB
      // FK is `on delete set null`, migration 020).
      setColumns((cur) =>
        cur.map((c) => ({
          ...c,
          tasks: c.tasks.map((t) => (t.phase_group_id === groupId ? { ...t, phase_group_id: null } : t)),
        }))
      );
    }
  }

  // ---- Drag and drop (Kanban view only, native HTML5 DnD) ----

  function onDragStart(taskId: string) {
    setDragTaskId(taskId);
  }

  async function onDrop(targetColumnId: string, targetIndex: number | null) {
    if (!dragTaskId) return;
    const taskId = dragTaskId;
    setDragTaskId(null);

    const sourceColumn = columns.find((c) => c.tasks.some((t) => t.id === taskId));
    const task = sourceColumn?.tasks.find((t) => t.id === taskId);
    if (!task) return;

    const destColumn = columns.find((c) => c.id === targetColumnId);
    if (!destColumn) return;

    const destTasksWithoutDragged = destColumn.tasks.filter((t) => t.id !== taskId);
    const index = targetIndex === null ? destTasksWithoutDragged.length : targetIndex;
    const before = destTasksWithoutDragged[index - 1];
    const after = destTasksWithoutDragged[index];
    let nextSort: number;
    if (before && after) {
      nextSort = Math.round((before.sort + after.sort) / 2);
      if (nextSort === before.sort) nextSort = before.sort + 1;
    } else if (before && !after) {
      nextSort = before.sort + SORT_STEP;
    } else if (!before && after) {
      nextSort = after.sort - SORT_STEP;
    } else {
      nextSort = 0;
    }

    const prev = columns;
    setColumns((cur) =>
      cur.map((c) => {
        if (c.id === sourceColumn!.id && c.id === destColumn.id) {
          const withoutDragged = c.tasks.filter((t) => t.id !== taskId);
          const updated = { ...task, column_id: targetColumnId, sort: nextSort };
          const list = [...withoutDragged];
          list.splice(index, 0, updated);
          return { ...c, tasks: list };
        }
        if (c.id === sourceColumn!.id) {
          return { ...c, tasks: c.tasks.filter((t) => t.id !== taskId) };
        }
        if (c.id === destColumn.id) {
          const updated = { ...task, column_id: targetColumnId, sort: nextSort };
          const list = [...c.tasks];
          list.splice(index, 0, updated);
          return { ...c, tasks: list };
        }
        return c;
      })
    );
    setError(null);
    try {
      await patchTask(task, { column_id: targetColumnId, sort: nextSort });
    } catch (err) {
      setColumns(prev);
      setError(err instanceof Error ? err.message : "Could not move card.");
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="flex items-center gap-1 border-b border-[#dcd6cc]">
        <button
          type="button"
          onClick={() => setView("kanban")}
          className={clsx(
            "border-b-2 px-3 py-2 text-subhead transition-colors",
            view === "kanban" ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/50 hover:text-nearblack"
          )}
        >
          Kanban
        </button>
        <button
          type="button"
          onClick={switchToGrouped}
          className={clsx(
            "border-b-2 px-3 py-2 text-subhead transition-colors",
            view === "grouped" ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/50 hover:text-nearblack"
          )}
        >
          Grouped list
        </button>
      </div>

      {view === "kanban" ? (
        <div className="flex items-start gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <BoardColumnView
              key={column.id}
              column={column}
              team={team}
              teamById={teamById}
              currentUserId={currentUserId}
              onDragStart={onDragStart}
              onDrop={onDrop}
              onRename={(name) => renameColumn(column.id, name)}
              onDelete={() => deleteColumn(column.id, column.name)}
              onAddTask={(title, assigneeIds) => addTask(column.id, title, assigneeIds)}
              onPatchTask={(task, patch, refUpdate) => updateTaskField(task, patch, refUpdate ?? {})}
              onDeleteTask={deleteTask}
            />
          ))}

          <div className="w-64 shrink-0">
            {addingColumn ? (
              <form onSubmit={addColumn} className="space-y-2 border border-[#dcd6cc] bg-offwhite p-3">
                <input
                  autoFocus
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  placeholder="Column name"
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
                />
                <div className="flex gap-2">
                  <button type="submit" className="bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal">
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingColumn(false);
                      setNewColumnName("");
                    }}
                    className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setAddingColumn(true)}
                className="w-full border border-dashed border-[#c9c2b4] px-3 py-3 text-subhead text-charcoal/60 transition-colors hover:border-nearblack hover:text-nearblack"
              >
                + Add column
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <GroupTable
              key={group.id}
              group={group}
              columnById={columnById}
              teamById={teamById}
              groups={groups}
              onRename={(name) => renameGroup(group.id, name)}
              onDelete={() => deleteGroup(group.id, group.name)}
              onPatchTask={(task, patch, refUpdate) => updateTaskField(task, patch, refUpdate ?? {})}
            />
          ))}

          {allTasks.some((t) => !t.phase_group_id) && (
            <UngroupedTable
              tasks={allTasks.filter((t) => !t.phase_group_id)}
              columnById={columnById}
              teamById={teamById}
              groups={groups}
              onPatchTask={(task, patch, refUpdate) => updateTaskField(task, patch, refUpdate ?? {})}
            />
          )}

          {addingGroup ? (
            <form onSubmit={addGroup} className="flex max-w-sm gap-2">
              <input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Phase name"
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
              + Add phase
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Kanban view
// ------------------------------------------------------------

function BoardColumnView({
  column,
  team,
  teamById,
  currentUserId,
  onDragStart,
  onDrop,
  onRename,
  onDelete,
  onAddTask,
  onPatchTask,
  onDeleteTask,
}: {
  column: BoardColumnWithAssigneeTasks;
  team: AssigneeSummary[];
  teamById: Map<string, AssigneeSummary>;
  currentUserId: string;
  onDragStart: (taskId: string) => void;
  onDrop: (columnId: string, index: number | null) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddTask: (title: string, assigneeIds: string[]) => void;
  onPatchTask: (task: BoardTaskWithAssignees, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithAssignees>) => void;
  onDeleteTask: (task: BoardTaskWithAssignees) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [composerAssignees, setComposerAssignees] = useState<string[]>([currentUserId]);
  const [dragOver, setDragOver] = useState(false);

  async function submitNewTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask(newTitle.trim(), composerAssignees);
    setNewTitle("");
    setComposerAssignees([currentUserId]);
  }

  return (
    <div
      className={clsx(
        "w-72 shrink-0 border border-[#dcd6cc] bg-offwhite",
        dragOver && "border-nearblack"
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDrop(column.id, column.tasks.length);
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[#dcd6cc] px-3 py-2">
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (nameDraft.trim() && nameDraft.trim() !== column.name) onRename(nameDraft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setNameDraft(column.name);
                setRenaming(false);
              }
            }}
            className="flex-1 border border-nearblack bg-nearwhite px-2 py-1 text-subhead text-nearblack focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(column.name);
              setRenaming(true);
            }}
            className="label-caps !text-nearblack hover:!text-sand"
          >
            {column.name} · {column.tasks.length}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title={column.tasks.length > 0 ? "Delete only when empty" : "Delete column"}
          className="text-caption text-charcoal/40 hover:text-red-700"
        >
          ✕
        </button>
      </div>

      <div className="space-y-2 p-2">
        {column.tasks.map((task, i) => (
          <BoardCard
            key={task.id}
            task={task}
            team={team}
            teamById={teamById}
            onDragStart={() => onDragStart(task.id)}
            onDropBefore={() => onDrop(column.id, i)}
            onPatch={(patch, refUpdate) => onPatchTask(task, patch, refUpdate)}
            onDelete={() => onDeleteTask(task)}
          />
        ))}

        {composing ? (
          <form onSubmit={submitNewTask} className="space-y-1.5 border border-[#c9c2b4] bg-nearwhite p-2">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setComposing(false)}
              placeholder="Card title"
              className="w-full border-none bg-transparent px-1 py-1 text-body focus:outline-none"
            />
            <AssigneeMultiPicker team={team} selected={composerAssignees} onChange={setComposerAssignees} />
            <div className="flex gap-2">
              <button type="submit" className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposing(false);
                  setNewTitle("");
                  setComposerAssignees([currentUserId]);
                }}
                className="text-caption text-charcoal/50 hover:text-nearblack"
              >
                Cancel
              </button>
            </div>
          </form>
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
    </div>
  );
}

/** Compact multi-select — checkboxes in a small list, auto-assign default pre-checked. Kept deliberately simple (no dropdown/combobox library) — team rosters in this app are small (a handful of people). */
function AssigneeMultiPicker({
  team,
  selected,
  onChange,
}: {
  team: AssigneeSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border border-[#e5e0d6] bg-white px-2 py-1.5">
      {team.map((t) => {
        const checked = selected.includes(t.id);
        return (
          <label key={t.id} className="flex items-center gap-1 text-caption text-charcoal/70">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                if (e.target.checked) onChange([...selected, t.id]);
                else onChange(selected.filter((id) => id !== t.id));
              }}
              className="h-3 w-3"
            />
            {t.full_name}
          </label>
        );
      })}
    </div>
  );
}

function AssigneeStack({ assignees }: { assignees: AssigneeSummary[] }) {
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

function BoardCard({
  task,
  team,
  teamById,
  onDragStart,
  onDropBefore,
  onPatch,
  onDelete,
}: {
  task: BoardTaskWithAssignees;
  team: AssigneeSummary[];
  teamById: Map<string, AssigneeSummary>;
  onDragStart: () => void;
  onDropBefore: () => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithAssignees>) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    if (!contactPickerOpen) return;
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, [contactPickerOpen]);

  const pastDue = isPastDue(task.due_date);

  function toggleAssignee(id: string) {
    const current = task.assignees.map((a) => a.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onPatch(
      { assignee_ids: next },
      { assignees: next.map((x) => teamById.get(x)).filter((p): p is AssigneeSummary => !!p) }
    );
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        onDropBefore();
      }}
      className={clsx(
        "cursor-move border bg-cream p-2 shadow-sm",
        dragOver ? "border-nearblack" : "border-[#dcd6cc]"
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="block w-full text-left text-body text-nearblack"
      >
        {task.title}
      </button>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <AssigneeStack assignees={task.assignees} />
        {task.contact && (
          <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
            {task.contact.company}
          </span>
        )}
        {task.due_date && (
          <span className={clsx("text-caption", pastDue ? "text-red-700" : "text-charcoal/50")}>
            {pastDue ? "⚠ " : ""}
            {new Date(task.due_date + "T00:00:00").toLocaleDateString("en-AU", {
              day: "numeric",
              month: "short",
            })}
          </span>
        )}
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-[#dcd6cc] pt-2">
          <textarea
            defaultValue={task.description ?? ""}
            placeholder="Description"
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== task.description) onPatch({ description: v });
            }}
            rows={2}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          />

          <div>
            <p className="label-caps mb-1 !text-sand">Assigned</p>
            <div className="flex flex-wrap gap-2">
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
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
              onClick={() => setContactPickerOpen((o) => !o)}
              className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal hover:border-nearblack"
            >
              {task.contact ? task.contact.company : "Link contact"}
            </button>
          </div>
          {contactPickerOpen && (
            <div className="max-h-32 overflow-y-auto border border-[#c9c2b4] bg-nearwhite">
              <button
                type="button"
                onClick={() => {
                  onPatch({ contact_id: null }, { contact: null });
                  setContactPickerOpen(false);
                }}
                className="block w-full border-b border-[#e5e0d6] px-2 py-1 text-left text-caption text-charcoal/60 hover:bg-cream"
              >
                No link
              </button>
              {contacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onPatch(
                      { contact_id: c.id },
                      { contact: { id: c.id, company: c.company, contact_name: c.contact_name } }
                    );
                    setContactPickerOpen(false);
                  }}
                  className="block w-full border-b border-[#e5e0d6] px-2 py-1 text-left text-caption text-charcoal hover:bg-cream"
                >
                  {c.company}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="text-caption text-red-700/70 hover:text-red-700"
          >
            Remove card
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Grouped list view (Monday-style vertical phase tables)
// ------------------------------------------------------------

function GroupTable({
  group,
  columnById,
  teamById,
  groups,
  onRename,
  onDelete,
  onPatchTask,
}: {
  group: BoardGroupWithTasks;
  columnById: Map<string, BoardColumnWithAssigneeTasks>;
  teamById: Map<string, AssigneeSummary>;
  groups: BoardGroupWithTasks[];
  onRename: (name: string) => void;
  onDelete: () => void;
  onPatchTask: (task: BoardTaskWithAssignees, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithAssignees>) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);

  return (
    <div className="border border-[#dcd6cc]">
      <div className="flex items-center justify-between gap-2 border-b border-[#dcd6cc] bg-offwhite px-3 py-2">
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (nameDraft.trim() && nameDraft.trim() !== group.name) onRename(nameDraft.trim());
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="flex-1 border border-nearblack bg-nearwhite px-2 py-1 text-subhead text-nearblack focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(group.name);
              setRenaming(true);
            }}
            className="label-caps !text-nearblack hover:!text-sand"
          >
            {group.name} · {group.tasks.length}
          </button>
        )}
        <button type="button" onClick={onDelete} className="text-caption text-charcoal/40 hover:text-red-700">
          ✕
        </button>
      </div>
      <GroupRows tasks={group.tasks} columnById={columnById} teamById={teamById} groups={groups} onPatchTask={onPatchTask} />
    </div>
  );
}

function UngroupedTable({
  tasks,
  columnById,
  teamById,
  groups,
  onPatchTask,
}: {
  tasks: BoardTaskWithAssignees[];
  columnById: Map<string, BoardColumnWithAssigneeTasks>;
  teamById: Map<string, AssigneeSummary>;
  groups: BoardGroupWithTasks[];
  onPatchTask: (task: BoardTaskWithAssignees, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithAssignees>) => void;
}) {
  return (
    <div className="border border-dashed border-[#c9c2b4]">
      <div className="border-b border-dashed border-[#c9c2b4] bg-transparent px-3 py-2">
        <p className="label-caps !text-charcoal/40">Ungrouped · {tasks.length}</p>
      </div>
      <GroupRows tasks={tasks} columnById={columnById} teamById={teamById} groups={groups} onPatchTask={onPatchTask} />
    </div>
  );
}

function GroupRows({
  tasks,
  columnById,
  teamById,
  groups,
  onPatchTask,
}: {
  tasks: BoardTaskWithAssignees[];
  columnById: Map<string, BoardColumnWithAssigneeTasks>;
  teamById: Map<string, AssigneeSummary>;
  groups: BoardGroupWithTasks[];
  onPatchTask: (task: BoardTaskWithAssignees, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithAssignees>) => void;
}) {
  if (tasks.length === 0) {
    return <p className="px-3 py-3 text-caption text-charcoal/40">No cards yet.</p>;
  }
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b border-[#e5e0d6] text-caption text-charcoal/40">
          <th className="px-3 py-1.5 font-normal">Title</th>
          <th className="px-3 py-1.5 font-normal">Assignees</th>
          <th className="px-3 py-1.5 font-normal">Contact</th>
          <th className="px-3 py-1.5 font-normal">Due</th>
          <th className="px-3 py-1.5 font-normal">Status</th>
          <th className="px-3 py-1.5 font-normal">Phase</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const pastDue = isPastDue(task.due_date);
          return (
            <tr key={task.id} className="border-b border-[#e5e0d6] last:border-b-0 hover:bg-nearwhite">
              <td className="px-3 py-2 text-body text-nearblack">{task.title}</td>
              <td className="px-3 py-2">
                <AssigneeStack assignees={task.assignees} />
              </td>
              <td className="px-3 py-2 text-caption text-charcoal/60">{task.contact?.company ?? "—"}</td>
              <td className={clsx("px-3 py-2 text-caption", pastDue ? "text-red-700" : "text-charcoal/60")}>
                {task.due_date
                  ? new Date(task.due_date + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })
                  : "—"}
              </td>
              <td className="px-3 py-2">
                <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/60">
                  {columnById.get(task.column_id)?.name ?? "—"}
                </span>
              </td>
              <td className="px-3 py-2">
                <select
                  value={task.phase_group_id ?? ""}
                  onChange={(e) => onPatchTask(task, { phase_group_id: e.target.value || null }, { phase_group_id: e.target.value || null })}
                  className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
                >
                  <option value="">Ungrouped</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
