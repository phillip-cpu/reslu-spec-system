"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type {
  AssigneeSummary,
  BoardColumnWithAssigneeTasks,
  BoardGroup,
  BoardGroupWithTasks,
  BoardTaskWithAssignees,
} from "@/types/phase-12a-b";
import type { Contact } from "@/types";
import { BOARD_LAYOUT_STORAGE_KEY, type BoardLayoutMode } from "@/types/phase-fix-a";

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
 * Project board — Board v2 (BUILD-SPEC.md §"Board v2") + Fix Round A
 * "Board vertical layout". Two independent axes:
 *
 *   1. VIEW — what a card is grouped by:
 *      - Kanban ("status view"): grouped by status column (Waiting/To
 *        Do/In Progress/Done).
 *      - Grouped list ("phase view"): grouped by unified phase
 *        (board_groups, lazily seeded via the shared seed path on
 *        first visit to THIS view — see lib/phase-seed.ts — Fix Round
 *        A's phase unification means these groups are now the SAME
 *        rows as Timeline phases). A card's phase_group_id and
 *        column_id are independent — this view edits phase_group_id
 *        via a per-row picker and shows the status column as a
 *        read-only chip.
 *
 *   2. LAYOUT — how either view arranges its groups on screen
 *      (BUILD-SPEC.md "Board vertical layout"):
 *      - "stacked" (DEFAULT): every group (status column OR phase
 *        group, whichever the current VIEW is) renders as a
 *        full-width section, top to bottom, each a compact card
 *        table — same pattern the Grouped list view already used
 *        pre-Fix-Round-A, now applied to Kanban too. Drag-and-drop
 *        works between stacked sections (a row is draggable, each
 *        section is a drop target); a "Move to..." dropdown on every
 *        row is the tap→move-menu fallback for touch (BUILD-SPEC.md
 *        mobile pass: "long-press drag or tap→move-to menu on
 *        touch").
 *      - "side-by-side": the ORIGINAL Week-9/Board-v2 horizontal
 *        kanban (columns side by side, native HTML5 DnD, card-style
 *        BoardCard with its own expand-on-tap panel) — kept available
 *        behind the toggle, unchanged mechanics.
 *      Persisted per-BROWSER in localStorage (BOARD_LAYOUT_STORAGE_KEY,
 *      types/phase-fix-a.ts) — BUILD-SPEC.md: "persist per user in
 *      localStorage". The Grouped list view was ALREADY vertical
 *      before this round (Monday-style stacked phase tables); the
 *      layout toggle only changes anything visible when VIEW is
 *      Kanban, but the SAME toggle state applies to both views for a
 *      single, predictable mental model ("vertical" vs "side-by-side"
 *      is one decision, not two).
 *
 * Auto-assign on create: a new card is assigned to `currentUserId`
 * automatically unless the composer's assignee picker is used to
 * override before submitting (BUILD-SPEC.md "Board v2" point 1).
 */
export function ProjectBoard({ projectId, initialColumns, initialGroups, team, currentUserId }: Props) {
  // Grouped list (phases) is the daily-driver view — Phillip, 6 Jul.
  const [view, setView] = useState<"kanban" | "grouped">("grouped");
  const [layout, setLayout] = useState<BoardLayoutMode>("stacked");
  const [columns, setColumns] = useState<BoardColumnWithAssigneeTasks[]>(initialColumns);
  const [groups, setGroups] = useState<BoardGroupWithTasks[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [groupsSeeded, setGroupsSeeded] = useState(initialGroups.length > 0);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  // Layout preference — read once on mount (SSR-safe: localStorage
  // doesn't exist server-side, so the initial render always uses the
  // "stacked" default and swaps in the saved preference client-side
  // immediately after, same one-render flash every localStorage-backed
  // preference in a Next.js app accepts).
  useEffect(() => {
    const saved = window.localStorage.getItem(BOARD_LAYOUT_STORAGE_KEY);
    if (saved === "stacked" || saved === "side-by-side") setLayout(saved);
  }, []);

  function changeLayout(next: BoardLayoutMode) {
    setLayout(next);
    window.localStorage.setItem(BOARD_LAYOUT_STORAGE_KEY, next);
  }

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
          // The seed route returns bare BoardGroup rows (no nested
          // tasks/phase dates — a freshly seeded group has neither yet).
          // Round A's phase_start_date/phase_end_date default to null
          // here; they're populated properly on the NEXT full board GET
          // (e.g. a page reload), same as `tasks: []` already did before
          // this round for a brand new group.
          setGroups(
            seeded.map((g: BoardGroup) => ({ ...g, tasks: [], phase_start_date: null, phase_end_date: null }))
          );
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

  /**
   * "Three from Phillip — 6 July 2026 evening" item 3 (grouped-list
   * add-task): `phaseGroupId` is a new optional 4th param — every
   * existing call site (both kanban composers) omits it, so behaviour
   * there is unchanged. When provided (the new grouped-view composer,
   * see GroupTable below), the created task is ALSO appended into
   * `groups` state so it shows up immediately in the grouped list
   * without a reload — `columns` state is still updated too (a task
   * always belongs to a status column regardless of which view created
   * it), matching how `patchTask`'s phase_group_id branch already keeps
   * both `columns` and `groups` in sync for existing tasks (see that
   * function's own `targetGroupId` handling below).
   */
  async function addTask(columnId: string, title: string, assigneeIds: string[], phaseGroupId?: string) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          column_id: columnId,
          title,
          assignee_ids: assigneeIds,
          ...(phaseGroupId ? { phase_group_id: phaseGroupId } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add card.");
      const { task } = await res.json();
      const assignees = assigneeIds.map((id) => teamById.get(id)).filter((p): p is AssigneeSummary => !!p);
      const withRefs: BoardTaskWithAssignees = { ...task, assignees, contact: null };
      setColumns((cur) =>
        cur.map((c) => (c.id === columnId ? { ...c, tasks: [...c.tasks, withRefs] } : c))
      );
      if (phaseGroupId) {
        setGroups((cur) =>
          cur.map((g) => (g.id === phaseGroupId ? { ...g, tasks: [...g.tasks, withRefs] } : g))
        );
      }
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
    // A column_id change (the Stacked layout's "Move to" dropdown and
    // drag-onto-a-section drop, per-row Fix Round A additions) moves
    // the task between column buckets — same targeted re-slot approach
    // phase_group_id already used below, appended at the end of the
    // destination column (stacked sections don't track a meaningful
    // "position within column" the way side-by-side kanban cards do —
    // see StackedColumnSection's own doc comment).
    if ("column_id" in patch) {
      const targetColumnId = patch.column_id as string;
      setColumns((cur) => {
        const withoutTask = cur.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== task.id) }));
        return withoutTask.map((c) =>
          c.id === targetColumnId ? { ...c, tasks: [...c.tasks, { ...task, ...patch, ...refUpdate }] } : c
        );
      });
    }
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
      const { group }: { group: BoardGroup } = await res.json();
      // POST .../board/groups always links (or creates) a schedule_phases
      // row server-side (see that route's own "unification invariant"
      // doc comment) but its response is a bare board_groups row — no
      // joined phase dates. Round A's compact date inputs simply show
      // nothing for this brand-new group until the next full board GET
      // (e.g. a reload), same "populates properly on next load" gap the
      // groups/seed path already has above.
      setGroups((cur) => [...cur, { ...group, tasks: [], phase_start_date: null, phase_end_date: null }]);
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

  /**
   * Round A "Board group date inputs" — a group's compact start/end
   * date inputs PATCH the LINKED schedule_phases row directly (PATCH
   * /api/phases/[id], the exact same route Timeline's own edit panel
   * already uses), never board_groups itself — board_groups carries no
   * date columns of its own; `phase_start_date`/`phase_end_date` on
   * BoardGroupWithTasks are a read-only projection of the linked
   * phase's own dates (see that type's own doc comment). Optimistic,
   * reverts on failure — same pattern every other inline edit in this
   * file already uses. Only ever called for a group with `phase_id`
   * set (the header only renders these inputs in that case — see
   * GroupTable below), so `phaseId` here is never null in practice.
   */
  async function patchGroupPhaseDates(groupId: string, phaseId: string, patch: { start_date?: string; end_date?: string }) {
    const prev = groups;
    setGroups((cur) =>
      cur.map((g) =>
        g.id === groupId
          ? {
              ...g,
              phase_start_date: patch.start_date ?? g.phase_start_date,
              phase_end_date: patch.end_date ?? g.phase_end_date,
            }
          : g
      )
    );
    setError(null);
    try {
      const res = await fetch(`/api/phases/${phaseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update phase dates.");
      const { phase: updated } = await res.json();
      setGroups((cur) =>
        cur.map((g) =>
          g.id === groupId ? { ...g, phase_start_date: updated.start_date, phase_end_date: updated.end_date } : g
        )
      );
    } catch (err) {
      setGroups(prev);
      setError(err instanceof Error ? err.message : "Could not update phase dates.");
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

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dcd6cc] pb-0">
        <div className="flex items-center gap-1">
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

        {/* Layout toggle — BUILD-SPEC.md "Board vertical layout":
            "Vertical becomes the DEFAULT layout ... side-by-side kanban
            stays available via a small layout toggle (persist per user
            in localStorage)." Only visibly changes anything when
            view === "kanban" (Grouped list has always been vertical),
            but the preference is shared across both views. */}
        <div className="mb-1 flex items-center gap-1 self-start">
          <span className="label-caps !text-charcoal/40">Layout</span>
          <button
            type="button"
            onClick={() => changeLayout("stacked")}
            title="Stacked (vertical) — default"
            className={clsx(
              "border px-2 py-1 text-caption",
              layout === "stacked" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal hover:border-nearblack"
            )}
          >
            Stacked
          </button>
          <button
            type="button"
            onClick={() => changeLayout("side-by-side")}
            title="Side-by-side kanban"
            className={clsx(
              "border px-2 py-1 text-caption",
              layout === "side-by-side" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal hover:border-nearblack"
            )}
          >
            Side-by-side
          </button>
        </div>
      </div>

      {view === "kanban" && layout === "stacked" && (
        <div className="space-y-6">
          {columns.map((column) => (
            <StackedColumnSection
              key={column.id}
              column={column}
              columns={columns}
              teamById={teamById}
              currentUserId={currentUserId}
              onDragStart={onDragStart}
              onDropOnColumn={() => onDrop(column.id, null)}
              onRename={(name) => renameColumn(column.id, name)}
              onDelete={() => deleteColumn(column.id, column.name)}
              onMoveTo={(task, targetColumnId) =>
                updateTaskField(task, { column_id: targetColumnId }, { column_id: targetColumnId })
              }
              onAddTask={(title, assigneeIds) => addTask(column.id, title, assigneeIds)}
            />
          ))}

          {addingColumn ? (
            <form onSubmit={addColumn} className="flex max-w-sm gap-2">
              <input
                autoFocus
                value={newColumnName}
                onChange={(e) => setNewColumnName(e.target.value)}
                placeholder="Column name"
                className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
              />
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
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAddingColumn(true)}
              className="border border-dashed border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal/60 transition-colors hover:border-nearblack hover:text-nearblack"
            >
              + Add column
            </button>
          )}
        </div>
      )}

      {view === "kanban" && layout === "side-by-side" && (
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
      )}

      {view === "grouped" && (
        <div className="space-y-6">
          {groups.map((group) => (
            <GroupTable
              key={group.id}
              group={group}
              columnById={columnById}
              teamById={teamById}
              groups={groups}
              currentUserId={currentUserId}
              onRename={(name) => renameGroup(group.id, name)}
              onDelete={() => deleteGroup(group.id, group.name)}
              onPatchTask={(task, patch, refUpdate) => updateTaskField(task, patch, refUpdate ?? {})}
              onPatchPhaseDates={(patch) => group.phase_id && patchGroupPhaseDates(group.id, group.phase_id, patch)}
              onAddTask={(title, assigneeIds) => {
                // "Three from Phillip — 6 July 2026 evening" item 3:
                // default column = first column (columns is already
                // ordered by the server query — see this file's own
                // research note on there being no prior "first column"
                // shortcut; this is the new one, scoped to this single
                // call site only).
                const defaultColumnId = columns[0]?.id;
                if (!defaultColumnId) {
                  setError("Add a status column before adding tasks.");
                  return;
                }
                addTask(defaultColumnId, title, assigneeIds, group.id);
              }}
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
// Stacked (vertical) Kanban section — Fix Round A "Board vertical
// layout" DEFAULT. One full-width section per status column, compact
// card table (same visual language as the Grouped list's GroupRows),
// top to bottom. Drag-and-drop: a row is draggable; the whole section
// is a drop target (drop anywhere in a section moves the card to that
// column, appended at the end — stacked sections don't need
// within-column reorder-by-position the way side-by-side kanban cards
// do, since a compact table row order isn't a meaningful "position in
// the column" signal the way a card's vertical stacking order is).
// Every row ALSO has a "Move to" dropdown — BUILD-SPEC.md mobile pass:
// "tap→move-to menu on touch" — so moving a card never strictly
// requires drag capability.
// ------------------------------------------------------------

function StackedColumnSection({
  column,
  columns,
  teamById,
  currentUserId,
  onDragStart,
  onDropOnColumn,
  onRename,
  onDelete,
  onMoveTo,
  onAddTask,
}: {
  column: BoardColumnWithAssigneeTasks;
  columns: BoardColumnWithAssigneeTasks[];
  teamById: Map<string, AssigneeSummary>;
  currentUserId: string;
  onDragStart: (taskId: string) => void;
  onDropOnColumn: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onMoveTo: (task: BoardTaskWithAssignees, targetColumnId: string) => void;
  onAddTask: (title: string, assigneeIds: string[]) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const [dragOver, setDragOver] = useState(false);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  function submitNewTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask(newTitle.trim(), [currentUserId]);
    setNewTitle("");
    setComposing(false);
  }

  return (
    <div
      className={clsx("border", dragOver ? "border-nearblack" : "border-[#dcd6cc]")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropOnColumn();
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[#dcd6cc] bg-offwhite px-3 py-2">
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (nameDraft.trim() && nameDraft.trim() !== column.name) onRename(nameDraft.trim());
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
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

      {column.tasks.length === 0 ? (
        <p className="px-3 py-3 text-caption text-charcoal/40">No cards yet.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[#e5e0d6] text-caption text-charcoal/40">
              <th className="px-3 py-1.5 font-normal">Title</th>
              <th className="px-3 py-1.5 font-normal">Assignees</th>
              <th className="px-3 py-1.5 font-normal">Contact</th>
              <th className="px-3 py-1.5 font-normal">Due</th>
              <th className="px-3 py-1.5 font-normal">Move to</th>
            </tr>
          </thead>
          <tbody>
            {column.tasks.map((task) => {
              const pastDue = isPastDue(task.due_date);
              return (
                <tr
                  key={task.id}
                  draggable
                  onDragStart={() => onDragStart(task.id)}
                  className="cursor-move border-b border-[#e5e0d6] last:border-b-0 hover:bg-nearwhite"
                >
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
                    <select
                      value={column.id}
                      onChange={(e) => {
                        if (e.target.value !== column.id) onMoveTo(task, e.target.value);
                      }}
                      className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
                    >
                      {columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="border-t border-[#e5e0d6] px-2 py-1.5">
        {composing ? (
          <form onSubmit={submitNewTask} className="flex gap-2">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setComposing(false)}
              placeholder="Card title"
              className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
            />
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
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="w-full px-1 py-1 text-left text-caption text-charcoal/50 hover:text-nearblack"
          >
            + Add card
          </button>
        )}
      </div>
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
      id={`focus-board_task-${task.id}`}
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
  currentUserId,
  onRename,
  onDelete,
  onPatchTask,
  onPatchPhaseDates,
  onAddTask,
}: {
  group: BoardGroupWithTasks;
  columnById: Map<string, BoardColumnWithAssigneeTasks>;
  teamById: Map<string, AssigneeSummary>;
  groups: BoardGroupWithTasks[];
  /** Auto-assign-to-me default for the new composer below — same convention as StackedColumnSection's own currentUserId prop. */
  currentUserId: string;
  onRename: (name: string) => void;
  onDelete: () => void;
  onPatchTask: (task: BoardTaskWithAssignees, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskWithAssignees>) => void;
  /** Round A "Board group date inputs" — omitted (or a no-op) for groups with no linked phase; the header only renders the inputs when group.phase_id is set (see JSX below). */
  onPatchPhaseDates: (patch: { start_date?: string; end_date?: string }) => void;
  /**
   * "Three from Phillip — 6 July 2026 evening" item 3: inline
   * "+ Add task" composer per group, reusing the exact same
   * title-only-input shape as the stacked-kanban composer
   * (StackedColumnSection above) rather than the richer side-by-side
   * one with an assignee picker — this view's rows are already dense
   * (title/assignees/contact/due/status/phase columns), so a minimal
   * composer matching the simpler of the two existing ones keeps the
   * footer from competing with the table for attention. The caller
   * (this file's main return block) resolves the default column +
   * calls addTask with this group's id as phaseGroupId.
   */
  onAddTask: (title: string, assigneeIds: string[]) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  function submitNewTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask(newTitle.trim(), [currentUserId]);
    setNewTitle("");
    setComposing(false);
  }

  return (
    <div className="border border-[#dcd6cc]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dcd6cc] bg-offwhite px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
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
          {/* Round A "Board owns dates, Timeline is the visual" — compact
              start/end inputs, ONLY for groups linked to a phase
              (phase_id present); unlinked/legacy groups render nothing
              extra here, per this round's brief. PATCHes the linked
              phase directly (PATCH /api/phases/[id]) via
              onPatchPhaseDates, optimistic — same single-source-of-truth
              path Timeline's own phase edit panel already uses, so a
              date changed here shows up on the Timeline tab and vice
              versa without any extra sync code. */}
          {group.phase_id && (
            <GroupPhaseDateInputs
              startDate={group.phase_start_date}
              endDate={group.phase_end_date}
              onPatch={onPatchPhaseDates}
            />
          )}
        </div>
        <button type="button" onClick={onDelete} className="text-caption text-charcoal/40 hover:text-red-700">
          ✕
        </button>
      </div>
      <GroupRows tasks={group.tasks} columnById={columnById} teamById={teamById} groups={groups} onPatchTask={onPatchTask} />
      {/* "Three from Phillip — 6 July 2026 evening" item 3: inline
          "+ Add task" composer, one per group — mirrors
          StackedColumnSection's footer composer above (same title-only
          input + Add/Cancel shape), reusing this file's single addTask()
          mutator with this group's id preset as phase_group_id (see the
          onAddTask wiring at this component's call site). */}
      <div className="border-t border-[#e5e0d6] px-3 py-1.5">
        {composing ? (
          <form onSubmit={submitNewTask} className="flex gap-2">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setComposing(false)}
              placeholder="Task title"
              className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
            />
            <button type="submit" className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">
              Add
            </button>
            <button type="button" onClick={() => { setComposing(false); setNewTitle(""); }} className="text-caption text-charcoal/50 hover:text-nearblack">
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setComposing(true)} className="w-full px-1 py-1 text-left text-caption text-charcoal/50 hover:text-nearblack">
            + Add task
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Round A "Board group date inputs" — compact start/end date pair
 * shown next to a phase-linked group's name in the Grouped-list header.
 * Local draft state + onBlur/onChange commit, same interaction pattern
 * every other inline date field in this codebase uses (see
 * GanttChart.tsx's PhaseEditPanel start/end inputs) — kept as its own
 * small component only because GroupTable's header needed re-syncing
 * local drafts whenever the group's phase dates change from elsewhere
 * (e.g. a Timeline drag on the SAME phase, next board refetch).
 */
function GroupPhaseDateInputs({
  startDate,
  endDate,
  onPatch,
}: {
  startDate: string | null;
  endDate: string | null;
  onPatch: (patch: { start_date?: string; end_date?: string }) => void;
}) {
  const [start, setStart] = useState(startDate ?? "");
  const [end, setEnd] = useState(endDate ?? "");

  useEffect(() => setStart(startDate ?? ""), [startDate]);
  useEffect(() => setEnd(endDate ?? ""), [endDate]);

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="date"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={() => start && start !== startDate && onPatch({ start_date: start })}
        className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-0.5 text-caption focus:border-nearblack focus:outline-none"
      />
      <span className="text-caption text-charcoal/40">→</span>
      <input
        type="date"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={() => end && end !== endDate && onPatch({ end_date: end })}
        className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-0.5 text-caption focus:border-nearblack focus:outline-none"
      />
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
            <tr key={task.id} id={`focus-board_task-${task.id}`} className="border-b border-[#e5e0d6] last:border-b-0 hover:bg-nearwhite">
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
