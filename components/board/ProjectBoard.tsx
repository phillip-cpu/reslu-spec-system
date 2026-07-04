"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type {
  BoardColumnWithTasks,
  BoardTaskWithRefs,
  Contact,
  Profile,
} from "@/types";

interface Props {
  projectId: string;
  initialColumns: BoardColumnWithTasks[];
  team: Pick<Profile, "id" | "full_name">[];
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
 * Project board (kanban) — BUILD-SPEC.md "Project board": columns
 * side-by-side (horizontal scroll on narrow), cards (title, assignee
 * initials circle, contact company chip, due date — red when past),
 * add-card composer per column, drag-drop between columns via native
 * HTML5 DnD (draggable + onDrop, persist column_id + sort),
 * rename/add/delete columns (delete only when empty).
 *
 * Sort scheme (documented in full in migration 013's comment on
 * board_tasks.sort and docs/API.md's "Address Book, Project board &
 * Gantt — Week 9" section): an integer
 * ladder with SORT_STEP=1000 gaps between siblings. Dropping a card
 * into a new position computes a sort value HALFWAY between its new
 * neighbours (or ± SORT_STEP past the end if dropped first/last) —
 * cheap, no renumbering of other rows needed for the common case.
 * If two cards ever end up needing the same integer (gap exhausted
 * after many reorders in the same spot), the PATCH still succeeds
 * (sort has no uniqueness constraint) — a card just ties for position
 * with its neighbour until the next full reload re-derives a fresh
 * ladder from array order, which self-heals the gap.
 */
export function ProjectBoard({ projectId, initialColumns, team }: Props) {
  const [columns, setColumns] = useState<BoardColumnWithTasks[]>(initialColumns);
  const [error, setError] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);

  const teamById = useMemo(() => new Map(team.map((t) => [t.id, t])), [team]);

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

  async function addTask(columnId: string, title: string) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ column_id: columnId, title }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add card.");
      const { task } = await res.json();
      const withRefs: BoardTaskWithRefs = { ...task, assignee: null, contact: null };
      setColumns((cur) =>
        cur.map((c) => (c.id === columnId ? { ...c, tasks: [...c.tasks, withRefs] } : c))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add card.");
    }
  }

  async function patchTask(task: BoardTaskWithRefs, patch: Record<string, unknown>) {
    const res = await fetch(`/api/board-tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Could not update card.");
    const { task: updated } = await res.json();
    return updated;
  }

  async function updateTaskField(task: BoardTaskWithRefs, patch: Record<string, unknown>, refUpdate: Partial<BoardTaskWithRefs>) {
    const prev = columns;
    setColumns((cur) =>
      cur.map((c) => ({
        ...c,
        tasks: c.tasks.map((t) => (t.id === task.id ? { ...t, ...patch, ...refUpdate } : t)),
      }))
    );
    setError(null);
    try {
      await patchTask(task, patch);
    } catch (err) {
      setColumns(prev);
      setError(err instanceof Error ? err.message : "Could not update card.");
    }
  }

  async function deleteTask(task: BoardTaskWithRefs) {
    if (!confirm(`Remove card "${task.title}"?`)) return;
    const prev = columns;
    setColumns((cur) => cur.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== task.id) })));
    const res = await fetch(`/api/board-tasks/${task.id}`, { method: "DELETE" });
    if (!res.ok) {
      setColumns(prev);
      setError("Could not remove card.");
    }
  }

  // ---- Drag and drop (native HTML5 DnD, no dependencies) ----

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

    // Build the destination task list EXCLUDING the dragged task, then
    // compute a sort value that slots it at targetIndex within that list.
    const destTasksWithoutDragged = destColumn.tasks.filter((t) => t.id !== taskId);
    const index = targetIndex === null ? destTasksWithoutDragged.length : targetIndex;
    const before = destTasksWithoutDragged[index - 1];
    const after = destTasksWithoutDragged[index];
    let nextSort: number;
    if (before && after) {
      nextSort = Math.round((before.sort + after.sort) / 2);
      // Gap exhausted between these two neighbours (adjacent integers) —
      // fall back to placing right after `before`; ties are harmless
      // (no uniqueness constraint) and self-heal on next full reload.
      if (nextSort === before.sort) nextSort = before.sort + 1;
    } else if (before && !after) {
      nextSort = before.sort + SORT_STEP;
    } else if (!before && after) {
      nextSort = after.sort - SORT_STEP;
    } else {
      nextSort = 0;
    }

    const prev = columns;
    // Optimistic local move.
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

      <div className="flex items-start gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <BoardColumnView
            key={column.id}
            column={column}
            team={team}
            teamById={teamById}
            onDragStart={onDragStart}
            onDrop={onDrop}
            onRename={(name) => renameColumn(column.id, name)}
            onDelete={() => deleteColumn(column.id, column.name)}
            onAddTask={(title) => addTask(column.id, title)}
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
    </div>
  );
}

function BoardColumnView({
  column,
  team,
  teamById,
  onDragStart,
  onDrop,
  onRename,
  onDelete,
  onAddTask,
  onPatchTask,
  onDeleteTask,
}: {
  column: BoardColumnWithTasks;
  team: Pick<Profile, "id" | "full_name">[];
  teamById: Map<string, Pick<Profile, "id" | "full_name">>;
  onDragStart: (taskId: string) => void;
  onDrop: (columnId: string, index: number | null) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddTask: (title: string) => void;
  onPatchTask: (task: BoardTaskWithRefs, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithRefs>) => void;
  onDeleteTask: (task: BoardTaskWithRefs) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);

  async function submitNewTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask(newTitle.trim());
    setNewTitle("");
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
            <div className="flex gap-2">
              <button type="submit" className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposing(false);
                  setNewTitle("");
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

function BoardCard({
  task,
  team,
  teamById,
  onDragStart,
  onDropBefore,
  onPatch,
  onDelete,
}: {
  task: BoardTaskWithRefs;
  team: Pick<Profile, "id" | "full_name">[];
  teamById: Map<string, Pick<Profile, "id" | "full_name">>;
  onDragStart: () => void;
  onDropBefore: () => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithRefs>) => void;
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
        {task.assignee && (
          <span
            title={task.assignee.full_name}
            className="flex h-5 w-5 items-center justify-center border border-sand text-caption !text-sand"
          >
            {initials(task.assignee.full_name)}
          </span>
        )}
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
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={task.assignee_id ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                onPatch(
                  { assignee_id: id },
                  { assignee: id ? teamById.get(id) ?? null : null }
                );
              }}
              className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
            >
              <option value="">Unassigned</option>
              {team.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name}
                </option>
              ))}
            </select>
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
