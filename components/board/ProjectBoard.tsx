"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { AssigneeSummary, BoardGroup } from "@/types/phase-12a-b";
import type { Contact } from "@/types";
import { BOARD_LAYOUT_STORAGE_KEY, type BoardLayoutMode } from "@/types/phase-fix-a";
// Board v3 — Monday parity round: BoardColumnV3/BoardGroupV3/BoardTaskV3
// (types/board-v3.ts) are structural supersets of their Board-cockpit-
// round counterparts (BoardColumnCockpit/BoardGroupCockpit/
// BoardTaskCockpit) — this whole file now uses BoardColumnV3/BoardTaskV3
// uniformly, including inside the kanban-only functions
// (StackedColumnSection, BoardColumnView, BoardCard,
// BoardTaskEditorBody, which never read `parent_task_id`).
//
// Bug fix, 7 July 2026: StackedColumnSection/BoardColumnView's `column`
// prop was left typed as BoardColumnCockpit (the narrower, pre-v3
// type) even though onMoveTo/every other callback here expects
// BoardTaskV3 (BoardColumnCockpit's own `tasks` are BoardTaskCockpit,
// which lacks parent_task_id) — a TS2345 "missing parent_task_id"
// build error, since a narrower-typed value can't be passed where the
// wider type is required, regardless of what the actual runtime data
// happens to contain. Both now correctly declare BoardColumnV3.
import type { BoardColumnV3, BoardGroupV3, BoardTaskV3 } from "@/types/board-v3";
import { shouldPromptMilestoneDiary } from "@/lib/board-cockpit";
// migration 041 ("Small pair" item 2) — datetime-aware overdue check,
// used wherever this file's own isPastDue() previously decided a due
// row's red styling for the row that also renders DueDateCell.
import { isOverdueByDateTime } from "@/lib/time-format";
import {
  stageColorForIndex,
  resolveStatusPillTint,
  computeDependencyChips,
  groupSummaryLine,
  subItemCountChip,
  computeGroupWorksDateRange,
  suggestStatusColumnName,
  isDoneColumnName,
} from "@/lib/board-constants";
import { ContactPicker } from "@/components/shared/ContactPicker";
import { GroupBookPanel } from "./GroupBookPanel";
import { MilestoneDiaryPrompt } from "./MilestoneDiaryPrompt";
import { AttentionBanner } from "./AttentionBanner";
// Board v3.3 — shared with GanttChart.tsx's own identical "Dates
// changed — re-send confirmation?" affordance, not duplicated here.
import { ReconfirmAffordance } from "@/components/gantt/ReconfirmAffordance";
// Board v3.1 — display-first cells: quiet-cell click-to-edit controls
// (see each file's own doc comment for the exact interaction shape).
import { StatusPill } from "./StatusPill";
import { DueDateCell, WorksDateCell } from "./DateCell";
import { PopoverCell } from "./PopoverCell";

interface Props {
  projectId: string;
  initialColumns: BoardColumnV3[];
  initialGroups: BoardGroupV3[];
  team: AssigneeSummary[];
  currentUserId: string;
}

const SORT_STEP = 1000;

// Board v3.2 — "Reorder slot animation". Row height in px, matching
// GroupRows' row className (`h-8` = 2rem = 32px) — used purely to
// compute how far a row needs to translate to open/close a one-row
// gap. A constant rather than a measured value: every row in this
// table renders at the exact same fixed height (no variable-height
// content — titles truncate via TaskTitleInline's `truncate` prop,
// see that component's own doc comment), so a literal matches the
// existing "no layout thrash, transforms only" brief without adding a
// ResizeObserver/getBoundingClientRect measurement this animation
// doesn't need.
const REORDER_ROW_PX = 32;
// ~120ms ease-out opening the gap while dragging, per BUILD-SPEC.md
// "Reorder slot animation" item 2 — reused for both the CSS
// transition duration below and (doubled, "brief... ease" per the
// same spec line) the on-drop settle animation.
const REORDER_GAP_MS = 120;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Bug fix, 8 July 2026: was `new Date(); today.setHours(0,0,0,0)` — that
 * truncates to midnight in the RUNTIME's own local timezone, which
 * differs between the server (Vercel, UTC) and the client (a browser in
 * Adelaide, UTC+9:30/+10:30). For roughly 9.5–10.5 hours of every single
 * day, UTC and Adelaide disagree about what calendar day "today" is —
 * so a task due "yesterday" by Adelaide's clock but still "today" by
 * the server's UTC clock rendered pastDue=true on the client but
 * pastDue=false in the server-rendered HTML (or vice versa), a genuine
 * React hydration mismatch (error #418) on every page load in that
 * window. Explicitly computing "today" in Australia/Adelaide via
 * Intl.DateTimeFormat (en-CA locale formats as YYYY-MM-DD) and doing a
 * plain string comparison against the due_date string sidesteps Date-
 * object/local-timezone ambiguity entirely — server and client now
 * compute the identical value regardless of which timezone their own
 * clock happens to be in, matching this app's established
 * Australia/Adelaide convention (lib/ics.ts, app/api/digest/flush).
 */
function isPastDue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(new Date());
  return dueDate < today;
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
  const [columns, setColumns] = useState<BoardColumnV3[]>(initialColumns);
  const [groups, setGroups] = useState<BoardGroupV3[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  // Phase-group reorder (Phillip, 7 July 2026) — dragging a phase's
  // whole section, not a task within it. Same sort-ladder + optimistic-
  // update-then-PATCH-then-revert shape as onDropInGroup below, just
  // operating on `groups` itself via PATCH /api/board-groups/[id]'s
  // existing `sort` field rather than a task's phase_group_id/sort.
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [groupsSeeded, setGroupsSeeded] = useState(initialGroups.length > 0);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  // Board v3 — Monday parity round: loading flag for the "Apply stage
  // template" banner button, same shape as every other async-button
  // "in flight" flag in this codebase.
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  // Board cockpit round — milestone-complete diary prompt (see
  // lib/board-cockpit.ts's shouldPromptMilestoneDiary(), triggered from
  // updateTaskField below whenever a milestone-kind card's column_id
  // changes into a Done-like column).
  const [milestonePrompt, setMilestonePrompt] = useState<{ title: string } | null>(null);
  // Booking selection v2 (r24) — BUILD-SPEC.md §"Booking selection v2 +
  // Aria supplier invoices (r24)" items 1-3. Replaces the old bare
  // `groupBookOpen: boolean` (always opened blank from the "•••" menu)
  // with a seed carried at open time: either the checked rows from
  // `selectedTaskIds` below (action bar) or a single task id (per-item
  // "Book trade" button) — see GroupBookPanel's own header comment for
  // what each shape does once inside the panel. Replaces bookingTask/
  // BookVisitPanel as this file's own board entry point into trade
  // booking. VERIFICATION NOTE (r24 repair pass): the previous version
  // of this comment claimed BookVisitPanel.tsx "is still used by the
  // Timeline (GanttChart.tsx)" — checked while repairing this file, and
  // that turned out not to be true: GanttChart.tsx's own booking UI is
  // a separate, self-contained PhaseEditPanel (its own ContactPicker +
  // date fields + "Book trade" context-menu action) that never imports
  // BookVisitPanel. A repo-wide grep confirms BookVisitPanel.tsx has NO
  // remaining importer anywhere in the app — it is genuinely orphaned,
  // not "still used elsewhere". Left in place rather than deleted (out
  // of scope for this round's 8 spec items; deleting it is a call for
  // whoever picks up that follow-up, not an incidental side effect of
  // this repair) — flagged here, and in this round's own docs/API.md
  // section, so it isn't mistaken for live code again.
  const [groupBookSeed, setGroupBookSeed] = useState<string[] | null>(null);
  // Booking selection v2 (r24) — row/card-edge checkboxes on both board
  // views (StackedColumnSection's "board rows" and GroupRows' "phase-
  // card item rows" — BUILD-SPEC.md item 1). Board-level (not per-view)
  // so a selection persists across a Kanban<->Grouped-list tab switch;
  // cleared whenever the booking panel opened from it closes (sent or
  // cancelled — simplest behaviour, avoids stale ticked rows lingering
  // after either outcome).
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  function toggleTaskSelected(taskId: string) {
    setSelectedTaskIds((cur) => {
      const next = new Set(cur);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }
  // Board v3.1 — display-first cells, item 6: the "Update status
  // names" panel opened from the board's "..." overflow menu (near the
  // layout toggle) — the menu itself is a PopoverCell (see the JSX
  // below), which owns its own open/close state, so this file only
  // needs to track whether the PANEL is open.
  const [statusNamesPanelOpen, setStatusNamesPanelOpen] = useState(false);
  // Board v3.3 — "Dates changed — re-send confirmation?" affordance,
  // surfaced on a row whose linked visit was 'confirmed' at the moment
  // a direct works-date PATCH (WorksDateCell, GroupRows below) moved
  // its dates — same Set-of-visit-ids convention GanttChart.tsx's own
  // reconfirmPrompts already uses (components/gantt/ReconfirmAffordance.tsx
  // is shared, imported below, not duplicated), populated from PATCH
  // /api/board-tasks/[id]'s `reconfirm_visit_ids` response field.
  const [reconfirmPrompts, setReconfirmPrompts] = useState<Set<string>>(new Set());
  function dismissReconfirm(visitId: string) {
    setReconfirmPrompts((cur) => {
      const next = new Set(cur);
      next.delete(visitId);
      return next;
    });
  }
  async function resendConfirmation(visitId: string) {
    const res = await fetch(`/api/visits/${visitId}/resend-confirmation`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error ?? "Could not re-send confirmation.");
  }

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

  // Board v3 — Monday parity round: stage-complete dependency chips —
  // pure derivation (lib/board-constants.ts's computeDependencyChips),
  // recomputed whenever `groups` changes. Keyed by GROUP id (see that
  // function's own doc comment for why) — GroupTable looks up its own
  // chip text by its own group.id.
  const dependencyChipsByGroupId = useMemo(
    () =>
      computeDependencyChips(
        groups.map((g) => ({
          id: g.id,
          sort: g.sort,
          tasks: g.tasks.filter((t) => !t.parent_task_id).map((t) => ({ kind: t.kind, title: t.title })),
        }))
      ),
    [groups]
  );

  // Board v3 — Monday parity round: "sparse" for the whole-board
  // "Apply stage template" banner is defined at the WHOLE-BOARD level
  // — zero tasks across every group AND every column, not per-group
  // (documented here, at the point of use, and in
  // lib/phase-seed.ts/docs/API.md) — so a board where one stage has
  // cards but the other twelve are empty does NOT show this banner
  // (that's normal steady-state usage, not a fresh/empty board); the
  // banner is specifically for a board that has NEVER had a single
  // task added to ANY of its stage groups yet.
  const boardIsSparse = groups.length > 0 && allTasks.length === 0;

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

  /**
   * Board v3 — Monday parity round: "Apply stage template" banner
   * action — mirrors DesignTab.tsx's applyTemplate() exactly (POST the
   * backfill endpoint, then refetch the whole board so every freshly
   * created task — with its server-assigned id/sort — lands in state
   * correctly, rather than trying to hand-splice an unknown number of
   * new rows across an unknown number of groups client-side). Shown
   * only when the board is SPARSE at the WHOLE-BOARD level (see the
   * banner's own render-gate below this function for the exact
   * definition, repeated at the point of use per this round's
   * documentation requirement).
   */
  async function applyStageTemplate() {
    setApplyingTemplate(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board/apply-stage-template`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not apply the stage template.");
      const fresh = await fetch(`/api/projects/${projectId}/board`).then((r) => r.json());
      if (fresh.columns) setColumns(fresh.columns);
      if (fresh.groups) setGroups(fresh.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the stage template.");
    } finally {
      setApplyingTemplate(false);
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
      const withRefs: BoardTaskV3 = { ...task, assignees, contact: null };
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

  /**
   * Board v3 — Monday parity round: "Add sub-item" — creates a
   * board_tasks row with `parent_task_id` set (migration 031), one
   * level of nesting (the API rejects a depth-2 attempt with 400 — see
   * POST /api/projects/[id]/board's own doc comment). Deliberately a
   * SEPARATE function from addTask above (rather than a parameter
   * added to it) since sub-item creation has its own simpler shape —
   * no assignee picker, no explicit phase_group_id (always inherited
   * from the parent server-side, per that route's own inheritance
   * rule) — matching the row-level "Add sub-item" affordance's minimal
   * inline-title-only composer (see GroupRows below).
   *
   * `parentColumnId` is the PARENT's own column_id — a sub-item is
   * created into the SAME status column its parent currently sits in
   * (a sensible default; the row's own status <select> can change it
   * immediately afterwards like any other task) since there is no
   * separate "default column" concept for a sub-item the way there is
   * for a brand-new top-level task via the group's own composer.
   */
  async function addSubTask(parentTask: BoardTaskV3, title: string) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/board`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          column_id: parentTask.column_id,
          title,
          assignee_ids: [],
          parent_task_id: parentTask.id,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add sub-item.");
      const { task } = await res.json();
      const withRefs: BoardTaskV3 = { ...task, assignees: [], contact: null, visit: null };
      setColumns((cur) =>
        cur.map((c) => (c.id === withRefs.column_id ? { ...c, tasks: [...c.tasks, withRefs] } : c))
      );
      if (withRefs.phase_group_id) {
        setGroups((cur) =>
          cur.map((g) => (g.id === withRefs.phase_group_id ? { ...g, tasks: [...g.tasks, withRefs] } : g))
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add sub-item.");
    }
  }

  async function patchTask(task: BoardTaskV3, patch: Record<string, unknown>) {
    const res = await fetch(`/api/board-tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Could not update card.");
    // Board v3.3 — `reconfirm_visit_ids` populated only when this PATCH
    // touched booking_date/booking_end_date on a task linked to a
    // CONFIRMED visit (see PATCH /api/board-tasks/[id]'s WORKS-DATE /
    // VISIT SYNC doc comment) — flagged here so every caller of
    // updateTaskField (not just the WorksDateCell popover) gets the
    // affordance for free the moment it happens to touch booking dates.
    const { task: updated, reconfirm_visit_ids: reconfirmVisitIds } = await res.json();
    if (Array.isArray(reconfirmVisitIds) && reconfirmVisitIds.length > 0) {
      setReconfirmPrompts((cur) => {
        const next = new Set(cur);
        for (const visitId of reconfirmVisitIds) next.add(visitId);
        return next;
      });
    }
    return updated;
  }

  /** Unlinks a card's booking without deleting the underlying visit — see DELETE /api/board-tasks/[id]/book-visit's doc comment. */
  async function unlinkVisit(taskId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/board-tasks/${taskId}/book-visit`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not unlink the booking.");
      applyTaskPatch(taskId, { visit_id: null, booking_date: null, booking_end_date: null, visit: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink the booking.");
    }
  }

  function applyTaskPatch(taskId: string, patch: Partial<BoardTaskV3>) {
    // Board reorder round (7 July 2026) — re-sorts each bucket by `sort`
    // after applying the patch, so a sort-only change (drag-reorder
    // within a group, or the "Move up"/"Move down" touch fallback —
    // see onDropInGroup/moveTaskWithinGroup below) is reflected in row
    // ORDER immediately, not just in the underlying field. A patch that
    // doesn't touch `sort` re-sorts to the exact same order it already
    // had (a no-op), so this is safe to run unconditionally rather than
    // branching on which fields changed.
    const withPatch = (tasks: BoardTaskV3[]) =>
      tasks
        .map((t) => (t.id === taskId ? { ...t, ...patch } : t))
        .sort((a, b) => a.sort - b.sort);
    setColumns((cur) => cur.map((c) => ({ ...c, tasks: withPatch(c.tasks) })));
    setGroups((cur) => cur.map((g) => ({ ...g, tasks: withPatch(g.tasks) })));
  }

  /**
   * Board cockpit round — "completion prompts diary": whenever a card
   * moves INTO a Done-like column, check lib/board-cockpit.ts's
   * shouldPromptMilestoneDiary() (milestone-kind + previous column
   * wasn't already Done) and, if it fires, open the
   * MilestoneDiaryPrompt. Called from BOTH card-move paths — the
   * Stacked/Grouped "Move to" dropdown & drag (via updateTaskField
   * below) and the side-by-side kanban's native HTML5 drag-and-drop
   * (via onDrop below) — since either can move a card into Done.
   */
  function maybePromptMilestoneDiary(task: BoardTaskV3, previousColumnId: string, nextColumnId: string) {
    if (previousColumnId === nextColumnId) return;
    const previousColumn = columnById.get(previousColumnId);
    const nextColumn = columnById.get(nextColumnId);
    if (!nextColumn) return;
    if (shouldPromptMilestoneDiary(task.kind, previousColumn?.name ?? null, nextColumn.name)) {
      setMilestonePrompt({ title: task.title });
    }
  }

  async function updateTaskField(
    task: BoardTaskV3,
    patch: Record<string, unknown>,
    refUpdate: Partial<BoardTaskV3>
  ) {
    const prevColumns = columns;
    const prevGroups = groups;
    applyTaskPatch(task.id, { ...patch, ...refUpdate } as Partial<BoardTaskV3>);
    // A column_id change (the Stacked layout's "Move to" dropdown and
    // drag-onto-a-section drop, per-row Fix Round A additions) moves
    // the task between column buckets — same targeted re-slot approach
    // phase_group_id already used below, appended at the end of the
    // destination column (stacked sections don't track a meaningful
    // "position within column" the way side-by-side kanban cards do —
    // see StackedColumnSection's own doc comment).
    if ("column_id" in patch) {
      const targetColumnId = patch.column_id as string;
      maybePromptMilestoneDiary(task, task.column_id, targetColumnId);
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
      // full reload. Sorted by `sort` after insertion (not just
      // appended) so a drag-between-groups drop (onDropInGroup below,
      // which always sends a `sort` alongside phase_group_id placing
      // the task at its exact dropped position) lands in the right row
      // order immediately, not just at the bottom of the destination
      // group until the next reload.
      if ("phase_group_id" in patch) {
        setGroups((cur) => {
          const withoutTask = cur.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== task.id) }));
          const targetGroupId = patch.phase_group_id as string | null;
          if (!targetGroupId) return withoutTask;
          return withoutTask.map((g) =>
            g.id === targetGroupId
              ? { ...g, tasks: [...g.tasks, { ...task, ...patch, ...refUpdate }].sort((a, b) => a.sort - b.sort) }
              : g
          );
        });
      }
    } catch (err) {
      setColumns(prevColumns);
      setGroups(prevGroups);
      setError(err instanceof Error ? err.message : "Could not update card.");
    }
  }

  async function deleteTask(task: BoardTaskV3) {
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
   * BoardGroupV3 are a read-only projection of the linked
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

    maybePromptMilestoneDiary(task, task.column_id, targetColumnId);

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

  // ---- Drag and drop (Grouped-list view — "Round — trade exports, PDF
  // bundle + audit, board reorder + rename", 7 July 2026) ----
  // BUILD-SPEC.md "Export + board batch" item 4: "rows draggable
  // within a group (persist sort via existing integer-ladder); drag
  // between groups allowed = phase change (same PATCH as the picker)."
  // Mirrors onDrop above almost exactly (same before/after midpoint
  // sort-ladder math, same optimistic-update-then-PATCH-then-revert
  // shape) but re-slots within `groups` state (and, when the drop
  // target is a DIFFERENT group, also carries a phase_group_id change
  // — the exact same single PATCH body updateTaskField's
  // phase_group_id branch already sends from the per-row <select>
  // picker above, so drag and the picker are just two input methods
  // for the identical server-side write). A drop onto the "Ungrouped"
  // bucket (targetGroupId null) clears phase_group_id the same way the
  // picker's blank option already does.
  function onDropInGroup(targetGroupId: string | null, targetIndex: number | null) {
    if (!dragTaskId) return;
    const taskId = dragTaskId;
    setDragTaskId(null);

    const task = allTasks.find((t) => t.id === taskId);
    if (!task) return;

    // Board v3 — Monday parity round: sub-items reorder ONLY within
    // their own sibling set (same parent_task_id), NEVER across
    // parents or up to top level (BUILD-SPEC.md). A sub-item being
    // dragged (task.parent_task_id is set) is filtered down to its own
    // siblings here — the SAME parent's other sub-items, wherever they
    // currently live — and its phase_group_id/parent_task_id are never
    // touched by this path (dragging a sub-item row never changes
    // which group or which parent it belongs to, only its `sort`
    // within that fixed sibling set). Sub-item rows are NOT draggable
    // in the UI (see GroupRows' row — draggable is only set on
    // top-level rows), so `task.parent_task_id` is never actually set
    // here in practice; this guard exists purely so this shared
    // function can never silently misbehave if that ever changes.
    if (task.parent_task_id) {
      const siblings = allTasks.filter((t) => t.parent_task_id === task.parent_task_id);
      const withoutDragged = siblings.filter((t) => t.id !== taskId).sort((a, b) => a.sort - b.sort);
      const index = targetIndex === null ? withoutDragged.length : targetIndex;
      const before = withoutDragged[index - 1];
      const after = withoutDragged[index];
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
      updateTaskField(task, { sort: nextSort }, { sort: nextSort });
      return;
    }

    const destTasks = targetGroupId
      ? (groups.find((g) => g.id === targetGroupId)?.tasks ?? []).filter((t) => !t.parent_task_id)
      : allTasks.filter((t) => !t.phase_group_id && !t.parent_task_id);
    const destTasksWithoutDragged = destTasks.filter((t) => t.id !== taskId);
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

    const patch: Record<string, unknown> = { sort: nextSort };
    const refUpdate: Partial<BoardTaskV3> = { sort: nextSort };
    if (targetGroupId !== (task.phase_group_id ?? null)) {
      patch.phase_group_id = targetGroupId;
      refUpdate.phase_group_id = targetGroupId;
    }
    updateTaskField(task, patch, refUpdate);
  }

  /**
   * Drop a dragged phase-group section onto another group's header —
   * reorders the whole section, inserting it immediately before the
   * drop target. Same before/after midpoint sort-ladder math as
   * onDropInGroup above, computed against `groups` (already ordered by
   * `sort`, per GET /api/projects/[id]/board's query) with the dragged
   * group removed first, so its own old slot never double-counts.
   */
  async function onDropOnGroup(targetGroupId: string) {
    if (!dragGroupId || dragGroupId === targetGroupId) {
      setDragGroupId(null);
      return;
    }
    const draggedId = dragGroupId;
    setDragGroupId(null);

    const withoutDragged = groups.filter((g) => g.id !== draggedId);
    const targetIndex = withoutDragged.findIndex((g) => g.id === targetGroupId);
    if (targetIndex === -1) return;

    const before = withoutDragged[targetIndex - 1];
    const after = withoutDragged[targetIndex];
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

    const prev = groups;
    const reordered = [...withoutDragged];
    const dragged = groups.find((g) => g.id === draggedId);
    if (!dragged) return;
    reordered.splice(targetIndex, 0, { ...dragged, sort: nextSort });
    setGroups(reordered);

    const res = await fetch(`/api/board-groups/${draggedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sort: nextSort }),
    });
    if (!res.ok) {
      setGroups(prev);
      setError((await res.json()).error ?? "Could not reorder phase group.");
    }
  }

  /**
   * Touch fallback's "Move up"/"Move down" (item 4) — reorders the
   * task one slot within its CURRENT group (or the Ungrouped bucket),
   * same before/after sort-ladder math every other reorder path in
   * this file uses, no phase change. A no-op at either end of the
   * list.
   *
   * Approach: splice the task OUT of its ordered siblings, then back
   * IN at the target index — this "remove, then reinsert into the
   * gapless remainder" is the same technique array reordering always
   * needs (computing before/after directly against the pre-splice
   * array double-counts the task's own old slot and off-by-ones
   * depending on direction, which an earlier draft of this function
   * got wrong for the "move down" case specifically).
   */
  function moveTaskWithinGroup(task: BoardTaskV3, direction: -1 | 1) {
    // Board v3 — Monday parity round: a sub-item's sibling set is
    // every OTHER task sharing the same parent_task_id — NEVER its
    // parent's whole group — per BUILD-SPEC.md "sub-items only
    // reorder within their own sibling set (same parent_task_id),
    // never across parents or up to top level." A top-level task (no
    // parent_task_id) keeps the pre-v3 behaviour exactly (its sibling
    // set is its phase group, or the Ungrouped bucket) — the only
    // change here is EXCLUDING sub-items from a top-level task's own
    // sibling set (`!t.parent_task_id` added to both branches below),
    // so a top-level "Move up/down" can never accidentally swap sort
    // order with a sub-item row.
    const siblings = task.parent_task_id
      ? allTasks.filter((t) => t.parent_task_id === task.parent_task_id)
      : task.phase_group_id
        ? (groups.find((g) => g.id === task.phase_group_id)?.tasks ?? []).filter((t) => !t.parent_task_id)
        : allTasks.filter((t) => !t.phase_group_id && !t.parent_task_id);
    const ordered = [...siblings].sort((a, b) => a.sort - b.sort);
    const index = ordered.findIndex((t) => t.id === task.id);
    if (index === -1) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= ordered.length) return;

    const without = ordered.filter((t) => t.id !== task.id);
    const before = without[targetIndex - 1];
    const after = without[targetIndex];
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
    updateTaskField(task, { sort: nextSort }, { sort: nextSort });
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {/* QA fix round (r27) item 12 — "wire the dead attention
          aggregator" board half. See AttentionBanner's own header
          comment for the full story (GET /api/projects/[id]/attention
          had zero callers before this round). */}
      <AttentionBanner projectId={projectId} />

      {/* Booking selection v2 (r24) — board-wide selection action bar.
          Appears whenever at least one row/card-edge checkbox is ticked
          (StackedColumnSection's board rows or GroupRows' phase-card
          item rows — see selectedTaskIds' own doc comment above).
          "Book selected -> trade" opens GroupBookPanel seeded with every
          checked task id; the panel resolves a single trade contact
          from that seed (prefilled when unambiguous, per its own header
          comment) — this is the ONE entry point for "select several
          lines -> one email to one trade" (this round's acceptance
          test: select every carpentry line -> one booking email). */}
      {selectedTaskIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-nearblack bg-cream px-3 py-2">
          <span className="text-body text-nearblack">
            {selectedTaskIds.size} line{selectedTaskIds.size === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSelectedTaskIds(new Set())}
              className="text-caption text-charcoal/50 underline hover:text-nearblack"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setGroupBookSeed([...selectedTaskIds])}
              className="border border-nearblack bg-nearblack px-4 py-1.5 text-subhead text-white transition-colors hover:bg-charcoal"
            >
              Book selected → trade
            </button>
          </div>
        </div>
      )}

      {milestonePrompt && (
        <MilestoneDiaryPrompt
          projectId={projectId}
          milestoneTitle={milestonePrompt.title}
          onDismiss={() => setMilestonePrompt(null)}
          onCreated={() => setMilestonePrompt(null)}
        />
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

          {/* Board v3.1 — display-first cells, item 6: "..." overflow
              menu, next to the layout toggle — currently a single
              action ("Update status names") but kept as a menu (not a
              bare button) so a future round can add more overflow
              actions here without another UI decision. Reuses the same
              shared PopoverCell click-to-reveal wrapper as the grouped-
              list's WHO/CONTACT cells (click-outside + Esc close for
              free, rather than a third hand-rolled copy of that
              plumbing). */}
          <PopoverCell trigger="•••" triggerTitle="More board actions">
            {(close) => (
              <>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setStatusNamesPanelOpen(true);
                  }}
                  className="block w-full min-w-[10rem] px-2 py-1.5 text-left text-caption text-charcoal hover:bg-cream"
                >
                  Update status names…
                </button>
                {/* Booking selection v2 (r24) — the old bare "Group book a
                    trade…" entry point is REMOVED per BUILD-SPEC.md item 3
                    ("replaced by these two entry points" — the selection
                    action bar above and each row's own "Book trade"
                    button, both opening GroupBookPanel via groupBookSeed). */}
              </>
            )}
          </PopoverCell>
        </div>
      </div>

      {statusNamesPanelOpen && (
        <UpdateStatusNamesPanel
          columns={columns}
          onRenameColumn={renameColumn}
          onClose={() => setStatusNamesPanelOpen(false)}
        />
      )}

      {/* Booking selection v2 (r24) — the ONE board entry point into
          trade booking (single-line or grouped, both the same panel —
          see groupBookSeed's own doc comment above). Selection is
          cleared on close so a sent/cancelled panel never leaves stale
          ticked rows behind. */}
      {groupBookSeed !== null && (
        <GroupBookPanel
          projectId={projectId}
          seedTaskIds={groupBookSeed}
          onClose={() => {
            setGroupBookSeed(null);
            setSelectedTaskIds(new Set());
          }}
        />
      )}

      {view === "kanban" && layout === "stacked" && (
        <div className="space-y-6">
          {columns.map((column) => (
            <StackedColumnSection
              key={column.id}
              column={column}
              columns={columns}
              teamById={teamById}
              currentUserId={currentUserId}
              selectedTaskIds={selectedTaskIds}
              onToggleSelect={toggleTaskSelected}
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
              onBookVisit={(task) => setGroupBookSeed([task.id])}
              onUnlinkVisit={unlinkVisit}
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
          {/* Board v3 — Monday parity round: "Apply stage template"
              banner. SPARSE, for this banner's purposes, is defined at
              the WHOLE-BOARD level — zero tasks across the ENTIRE
              board (every group, every column), not per-group — see
              boardIsSparse above and lib/phase-seed.ts's
              applyStageTemplateToEmptyGroups() for the per-group
              idempotency rule the POST itself follows regardless of
              why this banner fired. Mirrors DesignTab.tsx's identical
              "Phases have no tasks yet — pre-fill ...?" banner
              verbatim (same copy shape, same button label pattern). */}
          {boardIsSparse && (
            <div className="flex items-center justify-between border border-[#dcd6cc] bg-offwhite px-4 py-3">
              <p className="text-body text-charcoal/70">
                Stages have no tasks yet — pre-fill each stage from the standard construction checklist?
              </p>
              <button
                type="button"
                onClick={applyStageTemplate}
                disabled={applyingTemplate}
                className="border border-nearblack px-4 py-1.5 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-50"
              >
                {applyingTemplate ? "Applying…" : "Apply stage template"}
              </button>
            </div>
          )}

          {groups.map((group, index) => (
            <GroupTable
              key={group.id}
              projectId={projectId}
              group={group}
              columnById={columnById}
              teamById={teamById}
              team={team}
              groups={groups}
              allColumnNames={columns.map((c) => c.name)}
              currentUserId={currentUserId}
              stageColor={stageColorForIndex(index)}
              dependencyChip={dependencyChipsByGroupId.get(group.id) ?? null}
              selectedTaskIds={selectedTaskIds}
              onToggleSelect={toggleTaskSelected}
              onRename={(name) => renameGroup(group.id, name)}
              onDelete={() => deleteGroup(group.id, group.name)}
              onPatchTask={(task, patch, refUpdate) => updateTaskField(task, patch, refUpdate ?? {})}
              onDeleteTask={(task) => deleteTask(task)}
              onBookVisit={(task) => setGroupBookSeed([task.id])}
              onUnlinkVisit={(taskId) => unlinkVisit(taskId)}
              onPatchPhaseDates={(patch) => group.phase_id && patchGroupPhaseDates(group.id, group.phase_id, patch)}
              onDragStartTask={onDragStart}
              onDropInGroup={(index) => onDropInGroup(group.id, index)}
              onMoveTask={moveTaskWithinGroup}
              onAddSubTask={(parentTask, title) => addSubTask(parentTask, title)}
              reconfirmPrompts={reconfirmPrompts}
              onResendConfirmation={resendConfirmation}
              onDismissReconfirm={dismissReconfirm}
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

          {allTasks.some((t) => !t.phase_group_id && !t.parent_task_id) && (
            <UngroupedTable
              tasks={allTasks.filter((t) => !t.phase_group_id)}
              columnById={columnById}
              teamById={teamById}
              team={team}
              groups={groups}
              allColumnNames={columns.map((c) => c.name)}
              selectedTaskIds={selectedTaskIds}
              onToggleSelect={toggleTaskSelected}
              onPatchTask={(task, patch, refUpdate) => updateTaskField(task, patch, refUpdate ?? {})}
              onDeleteTask={(task) => deleteTask(task)}
              onBookVisit={(task) => setGroupBookSeed([task.id])}
              onUnlinkVisit={(taskId) => unlinkVisit(taskId)}
              onDragStartTask={onDragStart}
              onDropInGroup={(index) => onDropInGroup(null, index)}
              onMoveTask={moveTaskWithinGroup}
              onAddSubTask={(parentTask, title) => addSubTask(parentTask, title)}
              reconfirmPrompts={reconfirmPrompts}
              onResendConfirmation={resendConfirmation}
              onDismissReconfirm={dismissReconfirm}
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
//
// Board v3.2 — "Reorder slot animation" was NOT ported here. That
// round's brief says to apply it "if trivially shareable", and it
// isn't: the animation opens a gap at a specific ROW INDEX a drop
// would land at (GroupRows' dragOverIndex, matched 1:1 against
// onDropAtIndex's existing index-based semantics) — this section has
// no equivalent per-row drop-index target at all (see the paragraph
// above: "drop anywhere in a section... appended at the end", no
// within-column reorder-by-position), only a single whole-section
// onDropOnColumn. Animating a gap that doesn't correspond to any real
// drop position this table already supports would be pure decoration
// with no matching interaction underneath it — worse than no
// animation. If a future round adds real within-column position drops
// here, GroupRows' dragOverIndex/gapTransform/playSettleAnimation
// pattern is written to be lifted as-is.
// ------------------------------------------------------------

function StackedColumnSection({
  column,
  columns,
  teamById,
  currentUserId,
  selectedTaskIds,
  onToggleSelect,
  onDragStart,
  onDropOnColumn,
  onRename,
  onDelete,
  onMoveTo,
  onAddTask,
}: {
  column: BoardColumnV3;
  columns: BoardColumnV3[];
  teamById: Map<string, AssigneeSummary>;
  currentUserId: string;
  /** Booking selection v2 (r24) — board rows' own edge checkboxes, see ProjectBoard's selectedTaskIds doc comment. */
  selectedTaskIds: Set<string>;
  onToggleSelect: (taskId: string) => void;
  onDragStart: (taskId: string) => void;
  onDropOnColumn: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onMoveTo: (task: BoardTaskV3, targetColumnId: string) => void;
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
              <th className="w-8 px-3 py-1.5 font-normal" />
              <th className="px-3 py-1.5 font-normal">Title</th>
              <th className="px-3 py-1.5 font-normal">Assignees</th>
              <th className="px-3 py-1.5 font-normal">Contact</th>
              <th className="px-3 py-1.5 font-normal">Booking</th>
              <th className="px-3 py-1.5 font-normal">Due</th>
              <th className="px-3 py-1.5 font-normal">Move to</th>
            </tr>
          </thead>
          <tbody>
            {column.tasks.map((task) => {
              // A done task can't be overdue — this table renders once
              // per status column, so `column` here IS the task's own
              // current column (e.g. this render pass IS the Done
              // column's card list for a task sitting in Done).
              const done = isDoneColumnName(column.name);
              const pastDue = !done && isPastDue(task.due_date);
              return (
                <tr
                  key={task.id}
                  draggable
                  onDragStart={() => onDragStart(task.id)}
                  className="cursor-move border-b border-[#e5e0d6] last:border-b-0 hover:bg-nearwhite"
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {/* Booking selection v2 (r24) — item 1: row-edge
                        checkbox, board rows. Feeds the action bar /
                        GroupBookPanel seed, never the row's own drag. */}
                    <input
                      type="checkbox"
                      checked={selectedTaskIds.has(task.id)}
                      onChange={() => onToggleSelect(task.id)}
                      className="h-3.5 w-3.5"
                    />
                  </td>
                  <td className="px-3 py-2 text-body text-nearblack">
                    <span className="flex items-center gap-1.5">
                      {task.kind === "milestone" && <MilestoneDiamond />}
                      {task.title}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <AssigneeStack assignees={task.assignees} />
                  </td>
                  <td className="px-3 py-2 text-caption text-charcoal/60">{task.contact?.company ?? "—"}</td>
                  <td className="px-3 py-2 text-caption !text-sand">
                    {task.booking_date
                      ? `${formatShortDate(task.booking_date)}${task.visit ? ` · ${BOOKING_STATUS_LABEL[task.visit.status]}` : ""}`
                      : "—"}
                  </td>
                  <td className={clsx("px-3 py-2 text-caption", pastDue ? "text-red-700" : "text-charcoal/60")}>
                    {task.due_date && !done ? formatShortDate(task.due_date) : "—"}
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

      {/* Board v3.1 — display-first cells, item 7: task composer —
          already a quiet single-line input + Add/Cancel on one row
          (no multi-line/heavy chrome to remove here); padding tightened
          slightly (py-1.5 -> py-1) to match this round's ~32px row
          rhythm. */}
      <div className="border-t border-[#e5e0d6] px-2 py-1">
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
  onBookVisit,
  onUnlinkVisit,
}: {
  column: BoardColumnV3;
  team: AssigneeSummary[];
  teamById: Map<string, AssigneeSummary>;
  currentUserId: string;
  onDragStart: (taskId: string) => void;
  onDrop: (columnId: string, index: number | null) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddTask: (title: string, assigneeIds: string[]) => void;
  onPatchTask: (task: BoardTaskV3, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  onDeleteTask: (task: BoardTaskV3) => void;
  /** Prefill fix: now passes the full task (was `taskId: string`) so BookVisitPanel can be preloaded with this card's own phase/trade/dates. */
  onBookVisit: (task: BoardTaskV3) => void;
  onUnlinkVisit: (taskId: string) => void;
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
            onBookVisit={() => onBookVisit(task)}
            onUnlinkVisit={() => onUnlinkVisit(task.id)}
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
  onBookVisit,
  onUnlinkVisit,
}: {
  task: BoardTaskV3;
  team: AssigneeSummary[];
  teamById: Map<string, AssigneeSummary>;
  onDragStart: () => void;
  onDropBefore: () => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  onDelete: () => void;
  /** Board cockpit round — opens ProjectBoard's BookVisitPanel for this card. */
  onBookVisit: () => void;
  /** Board cockpit round — unlinks (does not delete) this card's booked visit. */
  onUnlinkVisit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    if (!expanded) return;
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, [expanded]);

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
      <div className="flex w-full items-center gap-1.5 text-body text-nearblack">
        {task.kind === "milestone" && <MilestoneDiamond />}
        <TaskTitleInline title={task.title} onPatch={onPatch} />
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          title="Expand to edit description, assignees, due date & more"
          className="ml-auto shrink-0 text-caption text-charcoal/40 hover:text-sand"
        >
          {expanded ? "▴" : "▾"}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <AssigneeStack assignees={task.assignees} />
        {task.contact && (
          <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
            {task.contact.company}
          </span>
        )}
        {/* Board cockpit round — booking_date/booking_end_date shown
            distinctly from due_date (two-dates-per-card): the booking
            window carries a live status badge from the linked visit. */}
        {task.booking_date && (
          <span className="label-caps border border-sand px-1.5 py-0.5 !text-sand" title="Booked trade visit window">
            📅 {formatShortDate(task.booking_date)}
            {task.booking_end_date && task.booking_end_date !== task.booking_date
              ? `–${formatShortDate(task.booking_end_date)}`
              : ""}
            {task.visit ? ` · ${BOOKING_STATUS_LABEL[task.visit.status]}` : ""}
          </span>
        )}
        {task.due_date && (
          <span className={clsx("text-caption", pastDue ? "text-red-700" : "text-charcoal/50")} title="Due date">
            {pastDue ? "⚠ " : ""}
            {formatShortDate(task.due_date)}
          </span>
        )}
      </div>

      {expanded && (
        <BoardTaskEditorBody
          task={task}
          team={team}
          teamById={teamById}
          contacts={contacts}
          onPatch={onPatch}
          onDelete={onDelete}
          onBookVisit={onBookVisit}
          onUnlinkVisit={onUnlinkVisit}
        />
      )}
    </div>
  );
}

/**
 * Board cockpit round — item 9 "Grouped-list edit parity": the FULL
 * card editor body (description, assignees, due date, booking date,
 * contact, milestone toggle, book-trade/unlink, remove), extracted out
 * of BoardCard so BOTH the kanban card's expand-in-place editor AND the
 * grouped-list row's expand-in-place editor (see GroupRows below) share
 * the exact same component rather than the grouped-list view carrying
 * a second, thinner, divergent editor (its previous inline
 * due_date/status/phase-only cells were exactly this "two divergent
 * implementations" the round brief called out to fix). Pure
 * presentational props in, callbacks out — no drag/expand state of its
 * own, that stays owned by each shell (BoardCard / GroupRows) since
 * kanban and grouped-list want different trigger affordances around
 * it (a draggable card shell vs. a table row).
 *
 * Field labels: "Due (to-do)" and "Booking date (works)" per this
 * round's brief — distinguishing the task's own deadline from the
 * booked trade-visit window at the editor level, not just the card's
 * display chips (which already distinguished them via the icon).
 * booking_date/booking_end_date are NOT directly editable inputs here
 * (migration 029's board_tasks.visit_id comment: those two columns are
 * only ever written via POST/DELETE .../book-visit so a card's booking
 * state always has one auditable write path) — "editable from both
 * editors" is satisfied via the Book trade / Unlink booking actions
 * below, present in both BoardCard and GroupRows now.
 */
function BoardTaskEditorBody({
  task,
  team,
  teamById,
  contacts,
  onPatch,
  onDelete,
  onBookVisit,
  onUnlinkVisit,
}: {
  task: BoardTaskV3;
  team: AssigneeSummary[];
  teamById: Map<string, AssigneeSummary>;
  contacts: Contact[];
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  onDelete: () => void;
  onBookVisit: () => void;
  onUnlinkVisit: () => void;
}) {
  function toggleAssignee(id: string) {
    const current = task.assignees.map((a) => a.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onPatch(
      { assignee_ids: next },
      { assignees: next.map((x) => teamById.get(x)).filter((p): p is AssigneeSummary => !!p) }
    );
  }

  return (
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

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="label-caps !text-charcoal/40">Due (to-do)</span>
          <input
            type="date"
            defaultValue={task.due_date ?? ""}
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== task.due_date) onPatch({ due_date: v });
            }}
            className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="label-caps !text-sand">Contact</span>
          <ContactPicker
            contacts={contacts}
            selectedId={task.contact_id}
            onSelect={(contactId) => {
              const contact = contactId ? contacts.find((c) => c.id === contactId) ?? null : null;
              onPatch(
                { contact_id: contactId },
                { contact: contact ? { id: contact.id, company: contact.company, contact_name: contact.contact_name } : null }
              );
            }}
          />
        </label>
      </div>

      {/* Board cockpit round — "Booking date (works)" — the booking
          window here (booking_date/booking_end_date themselves are
          only writable via Book trade/Unlink below, per migration
          029's single-write-path discipline), so both dates are
          visible side by side in the one editor even though only one
          of them (due) is a free-typed input. */}
      <div className="flex flex-col gap-0.5">
        <span className="label-caps !text-sand">Booking date (works)</span>
        {task.booking_date ? (
          <span className="text-caption text-charcoal/70">
            {formatShortDate(task.booking_date)}
            {task.booking_end_date && task.booking_end_date !== task.booking_date
              ? `–${formatShortDate(task.booking_end_date)}`
              : ""}
            {task.visit ? ` · ${BOOKING_STATUS_LABEL[task.visit.status]}` : ""}
          </span>
        ) : (
          <span className="text-caption text-charcoal/40">Not booked — use &quot;Book trade&quot; below.</span>
        )}
      </div>

      {/* Board cockpit round — milestone toggle: kind='milestone' renders as a diamond on the Gantt timeline and prompts a diary entry on completion (see ProjectBoard's maybePromptMilestoneDiary()). */}
      <label className="flex items-center gap-2 text-caption text-charcoal/70">
        <input
          type="checkbox"
          checked={task.kind === "milestone"}
          onChange={(e) => onPatch({ kind: e.target.checked ? "milestone" : "task" }, { kind: e.target.checked ? "milestone" : "task" })}
          className="h-3 w-3"
        />
        Milestone (shows on Timeline, prompts a diary entry when completed)
      </label>

      {/* Board cockpit round — book-trade-from-card + live status badge. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[#e5e0d6] pt-2">
        {task.visit ? (
          <>
            <span className="text-caption text-charcoal/70">
              Booked: {formatShortDate(task.booking_date!)}
              {task.booking_end_date && task.booking_end_date !== task.booking_date
                ? `–${formatShortDate(task.booking_end_date)}`
                : ""}{" "}
              · {BOOKING_STATUS_LABEL[task.visit.status]}
              {task.visit.contact ? ` · ${task.visit.contact.company}` : ""}
            </span>
            <button
              type="button"
              onClick={onUnlinkVisit}
              className="text-caption text-charcoal/50 hover:text-red-700"
            >
              Unlink booking
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onBookVisit}
            className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal hover:border-nearblack"
          >
            Book trade
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onDelete}
        className="text-caption text-red-700/70 hover:text-red-700"
      >
        Remove card
      </button>
    </div>
  );
}

/** Board cockpit round — the diamond marker shown inline on a milestone card's title, matching the same diamond shape used on the Gantt timeline (see components/gantt/GanttChart.tsx's milestone markers). */
function MilestoneDiamond() {
  return (
    <span
      title="Milestone"
      className="inline-block h-2.5 w-2.5 shrink-0 rotate-45 border border-sand bg-sand/40"
    />
  );
}

/**
 * Bug fix, 7 July 2026: a task/card's title had NO edit path anywhere
 * in the app — clicking it only ever toggled the expanded card editor
 * (BoardTaskEditorBody), which itself has no title field (description,
 * assignees, due date, contact, milestone toggle, book-trade, delete —
 * but never title). The PATCH endpoint already accepted `title`
 * (app/api/board-tasks/[id]/route.ts's EDITABLE_FIELDS); only the UI
 * affordance was missing.
 *
 * Click-to-rename directly on the visible title text — same
 * interaction shape as GanttChart.tsx's PhaseNameInline (click -> input
 * -> blur/Enter saves, Escape cancels) and GroupTable's own stage-
 * heading rename, so a task's title now follows the same "click the
 * text itself" convention already established everywhere else in this
 * app rather than introducing a new pattern. Used by both BoardCard
 * (Kanban) and GroupRows (Grouped-list "line items") — each row/card
 * still has its own SEPARATE expand toggle for the full card editor
 * (description/assignees/etc.), since overloading one click target for
 * both "rename" and "expand" isn't possible.
 */
function TaskTitleInline({
  title,
  onPatch,
  truncate = false,
}: {
  title: string;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  /**
   * Board v3.1 — display-first cells, item 3: grouped-list rows are
   * single-line (~32px) — a long title must ellipsis rather than wrap
   * or push the row taller, with the FULL title available via the
   * native `title` attribute (hover tooltip). Kanban cards (BoardCard)
   * have room to wrap and omit this prop, keeping their pre-v3.1
   * behaviour (plain "Click to rename" tooltip, no truncation) exactly
   * as before — this is an opt-in per call site, not a global change
   * to this shared component.
   */
  truncate?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);

  function commit() {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      onPatch({ title: trimmed }, { title: trimmed });
    } else {
      setDraft(title);
    }
  }

  function cancel() {
    setDraft(title);
    setRenaming(false);
  }

  if (renaming) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") cancel();
        }}
        onClick={(e) => e.stopPropagation()}
        className="min-w-0 flex-1 border border-nearblack bg-nearwhite px-1 py-0.5 text-body text-nearblack focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setDraft(title);
        setRenaming(true);
      }}
      title={truncate ? title : "Click to rename"}
      className={clsx(
        "text-left text-body text-nearblack hover:text-sand",
        truncate && "min-w-0 flex-1 truncate"
      )}
    >
      {title}
    </button>
  );
}

const BOOKING_STATUS_LABEL: Record<string, string> = {
  unconfirmed: "Unconfirmed",
  confirmed: "Confirmed",
  tentative: "Tentative",
  declined: "Declined",
  proposed_change: "Trade proposed a change",
};

/**
 * Bug fix, 8 July 2026: was `toLocaleDateString("en-AU", { month:
 * "short" })` — a genuine React hydration mismatch, confirmed by
 * reproducing a non-minified error: the SAME date/locale/options
 * rendered "9 July" on the server (Node's bundled ICU data for en-AU)
 * but "9 Jul" on the client (Safari/WebKit's own ICU data) — a
 * cross-engine Intl/ICU data discrepancy (not a timezone issue — see
 * isPastDue's fix above for that separate bug class). A manual,
 * hardcoded month-abbreviation array has zero locale/ICU dependency,
 * so server and client can never disagree, regardless of engine.
 * Same fix as components/board/DateCell.tsx's identical formatShort.
 */
const SHORT_MONTHS_BOARD = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${SHORT_MONTHS_BOARD[d.getMonth()]}`;
}

// ------------------------------------------------------------
// Grouped list view (Monday-style vertical phase tables)
// ------------------------------------------------------------

/**
 * GroupTable — Board v3 — Monday parity round rebuild. BUILD-SPEC.md
 * "Board v3 — Monday parity" §2 "Visual parity": full-width table per
 * stage group, 4px coloured left edge bar + coloured stage title text
 * (rotating 5-colour brand-safe palette, lib/board-constants.ts's
 * STAGE_PALETTE, cycling by sort order — `stageColor` is passed in by
 * the caller, already resolved via stageColorForIndex(index in
 * groups.map)), column headers reading exactly "ITEM · WHO · STATUS ·
 * CONTACT · WORKS · DUE · AFTER", compact ~30px rows, group collapse
 * chevron + summary line ("N items · M done" — sub-items excluded),
 * "+ Add item" inline row at the bottom.
 *
 * PRESERVES EVERY EXISTING BEHAVIOUR from the pre-v3 GroupTable this
 * replaces: inline rename (click name -> input -> blur/Enter commits,
 * Escape cancels), drag reorder (row-level dragStart/onDropAtIndex,
 * whole-group onDropInGroup), both-dates editing (GroupPhaseDateInputs,
 * untouched, still gated on group.phase_id), "Book trade"/"Unlink
 * booking" (via the shared BoardTaskEditorBody, untouched), focus ids
 * (`focus-group-<id>` on the header, `focus-board_task-<id>` on each
 * row, both unchanged), phase date inputs + "View on timeline" link
 * (untouched), the inline add-task composer (untouched shape, now
 * labelled "+ Add item" per spec's column-header wording), tap→move
 * (the Status <select> in GroupRows, untouched), booking badges
 * (unchanged), milestones (◆ diamond, now ALSO carries a "MILESTONE"
 * chip per this round's spec).
 *
 * Board v3.2 — "Reorder slot animation" (GroupRows, below): dragging a
 * row now opens an animated gap (neighbouring rows translateY apart,
 * ~120ms ease-out, 2px sand drop-line) at whatever position
 * onDropAtIndex would actually insert at, settling with a brief
 * transform ease on drop. Purely a CSS-transform presentation layer on
 * top of the SAME dragTaskId/onDropAtIndex/onDropInGroup plumbing —
 * the HTML5 DnD backbone, the sort-ladder persistence, and every drop
 * coordinate/index this table already computed are all byte-for-byte
 * unchanged (see GroupRows' dragOverIndex/gapTransform doc comments).
 *
 * Prop surface: identical to the pre-v3 GroupTable PLUS three additive
 * props — `allColumnNames` (board-wide column-name list, for the
 * booking soft-mapping's /booked/i check), `stageColor` (this group's
 * resolved palette colour), `dependencyChip` (precomputed chip text or
 * null), and `onAddSubTask` (row-level "Add sub-item"). Every existing
 * prop keeps its exact name and signature.
 */
function GroupTable({
  projectId,
  group,
  columnById,
  teamById,
  team,
  groups,
  allColumnNames,
  currentUserId,
  stageColor,
  dependencyChip,
  selectedTaskIds,
  onToggleSelect,
  onRename,
  onDelete,
  onPatchTask,
  onDeleteTask,
  onBookVisit,
  onUnlinkVisit,
  onPatchPhaseDates,
  onAddTask,
  onAddSubTask,
  onDragStartTask,
  onDropInGroup,
  onMoveTask,
  reconfirmPrompts,
  onResendConfirmation,
  onDismissReconfirm,
}: {
  /** Timeline Day-zoom polish round — item 5's reciprocal "View on timeline" link, built here rather than passed as a ready-made href since the group's own phase_id (below) is what the link target actually needs. */
  projectId: string;
  group: BoardGroupV3;
  columnById: Map<string, BoardColumnV3>;
  teamById: Map<string, AssigneeSummary>;
  /** Board cockpit round — item 9 parity: threaded through to GroupRows' shared BoardTaskEditorBody. */
  team: AssigneeSummary[];
  groups: BoardGroupV3[];
  /** Booking selection v2 (r24) — item 1: phase-card item rows' own edge checkboxes, threaded through to GroupRows. See ProjectBoard's selectedTaskIds doc comment. */
  selectedTaskIds: Set<string>;
  onToggleSelect: (taskId: string) => void;
  /** Board v3 — Monday parity round: every status column's name on this board, for the booking soft-mapping's /booked/i check (lib/board-constants.ts's boardHasBookedColumn/resolveStatusPillTint) — see GroupRows' status cell for where this is actually consumed. */
  allColumnNames: string[];
  /** Auto-assign-to-me default for the new composer below — same convention as StackedColumnSection's own currentUserId prop. */
  currentUserId: string;
  /** Board v3 — Monday parity round: this group's resolved colour from the 5-colour rotating STAGE_PALETTE (lib/board-constants.ts), already indexed by the caller via stageColorForIndex(sort-order index). Used for both the 4px left edge bar and the stage title text colour. */
  stageColor: string;
  /** Board v3 — Monday parity round: precomputed "after ◆ {prev milestone title}" chip text (lib/board-constants.ts's computeDependencyChips), or null if the previous group has no milestone / this is the first group. Shown on the FIRST non-milestone row only (see GroupRows). */
  dependencyChip: string | null;
  onRename: (name: string) => void;
  onDelete: () => void;
  onPatchTask: (task: BoardTaskV3, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  /** Board cockpit round — item 9 parity: "Remove card" from the shared editor. */
  onDeleteTask: (task: BoardTaskV3) => void;
  /** Board cockpit round — item 9 parity: "Book trade" from the shared editor. Prefill fix: now passes the full task (was `taskId: string`) so BookVisitPanel can be preloaded with this card's own phase/trade/dates. */
  onBookVisit: (task: BoardTaskV3) => void;
  /** Board cockpit round — item 9 parity: "Unlink booking" from the shared editor. */
  onUnlinkVisit: (taskId: string) => void;
  /** Round A "Board group date inputs" — omitted (or a no-op) for groups with no linked phase; the header only renders the inputs when group.phase_id is set (see JSX below). */
  onPatchPhaseDates: (patch: { start_date?: string; end_date?: string }) => void;
  /**
   * "Three from Phillip — 6 July 2026 evening" item 3: inline
   * "+ Add item" composer per group (labelled "+ Add task" pre-v3;
   * BUILD-SPEC.md's exact column-header wording for this view is
   * "ITEM", so this round's footer label follows suit — same
   * title-only-input shape as the stacked-kanban composer
   * (StackedColumnSection above) rather than the richer side-by-side
   * one with an assignee picker). The caller (this file's main return
   * block) resolves the default column + calls addTask with this
   * group's id as phaseGroupId.
   */
  onAddTask: (title: string, assigneeIds: string[]) => void;
  /** Board v3 — Monday parity round: row-level "Add sub-item" — creates a board_tasks row with parent_task_id set to the given parent, inheriting the parent's phase_group_id server-side (see POST /api/projects/[id]/board's doc comment). Threaded down to GroupRows, which renders the actual per-row affordance. */
  onAddSubTask: (parentTask: BoardTaskV3, title: string) => void;
  /** Board reorder round (7 July 2026) — HTML5 DnD, same dragTaskId-in-parent-state approach as the Kanban side's onDragStart above (see ProjectBoard's own onDragStart). */
  onDragStartTask: (taskId: string) => void;
  /** Drop anywhere in this group (header or row area) — reorders within the group, or moves the dragged task INTO this group (a phase change) if it came from elsewhere. `index` is the row position to insert at, or null to append at the end. */
  onDropInGroup: (index: number | null) => void;
  /** Touch fallback's "Move up"/"Move down" (item 4) — reorders one slot within the CURRENT group, no phase change. */
  onMoveTask: (task: BoardTaskV3, direction: -1 | 1) => void;
  /** Board v3.3 — visit ids currently showing the "Dates changed — re-send confirmation?" affordance (see ProjectBoard's own state of the same name). */
  reconfirmPrompts: Set<string>;
  onResendConfirmation: (visitId: string) => Promise<void>;
  onDismissReconfirm: (visitId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  // Board v3 — Monday parity round: group collapse chevron. Local,
  // per-group, defaults to expanded (false = not collapsed) — same
  // "starts open" default every collapsible section in this codebase
  // uses (e.g. no section in this app starts pre-collapsed without an
  // explicit reason to).
  const [collapsed, setCollapsed] = useState(false);

  // Board v3 — Monday parity round: only TOP-LEVEL tasks (no
  // parent_task_id) count toward this group's own rows/summary line —
  // sub-items are rendered nested under their parent by GroupRows
  // itself (which receives the FULL task list, top-level + sub-items,
  // and does its own grouping), but the group-level "N items · M done"
  // summary and the group's `tasks.length` header count both ignore
  // sub-items entirely, per BUILD-SPEC.md "Sub-items are excluded from
  // top-level group counts."
  const topLevelTasks = group.tasks.filter((t) => !t.parent_task_id);
  const summaryLine = groupSummaryLine(
    topLevelTasks.map((t) => ({ isSubItem: false, columnName: columnById.get(t.column_id)?.name ?? "" }))
  );

  // Board v3.1 — display-first cells, item 8: when ANY task in this
  // group has works dates set, the header shows the COMPUTED range
  // (read-only text, "derived from item dates" tooltip) instead of the
  // manual GroupPhaseDateInputs — mirrors the exact same min/max
  // formula the server-side rollup writes onto the linked
  // schedule_phases row (lib/phase-rollup.ts's
  // rollupPhaseDatesForGroup), via lib/board-constants.ts's
  // computeGroupWorksDateRange, so this client-side display can never
  // disagree with what the next server round-trip will show. Includes
  // ALL of the group's tasks (sub-items too) — a sub-item's own works
  // dates are just as real a signal of "this stage has scheduled work"
  // as its parent's, unlike the top-level-only summary line above.
  const groupWorksDateRange = computeGroupWorksDateRange(
    group.tasks.map((t) => ({ booking_date: t.booking_date, booking_end_date: t.booking_end_date }))
  );

  function submitNewTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask(newTitle.trim(), [currentUserId]);
    setNewTitle("");
    setComposing(false);
  }

  function startRename() {
    setNameDraft(group.name);
    setRenaming(true);
  }

  function commitRename() {
    setRenaming(false);
    if (nameDraft.trim() && nameDraft.trim() !== group.name) onRename(nameDraft.trim());
  }

  function cancelRename() {
    setNameDraft(group.name);
    setRenaming(false);
  }

  // Board v3.1 — display-first cells, item 5: the 4px stage-colour bar
  // moves from the HEADER row (pre-v3.1 — only spanned the header) onto
  // the OUTER wrapper below, which contains the header AND every row
  // (GroupRows) AND the "+ Add item" footer — so the bar now visually
  // runs the FULL height of the group, not just its header row. The
  // header's own title text keeps using the identical `stageColor`
  // value for its own colour (see the rename button's style further
  // down), so the two stay visually paired.
  return (
    <div
      className={clsx("border", dragOver ? "border-nearblack" : "border-[#dcd6cc]")}
      style={{ borderLeft: `4px solid ${stageColor}` }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // A drop directly on the header/wrapper (not on a specific row
        // — see GroupRows' own per-row onDrop below, which stops
        // propagation) appends at the end of this group, same
        // "dropped in the general area = end of list" convention
        // StackedColumnSection's onDropOnColumn already uses for
        // Kanban sections.
        onDropInGroup(null);
      }}
    >
      <div
        id={`focus-group-${group.id}`}
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
        title={collapsed ? "Expand stage" : "Collapse stage"}
        className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dcd6cc] bg-offwhite py-2 pr-3 cursor-pointer"
      >
        <div className="flex flex-wrap items-center gap-3 pl-3">
          {/* Bug fix, 7 July 2026: the whole header box is now the click
              target for collapse/expand (onClick above) — was previously
              only this small chevron. The chevron stays as an explicit
              visual affordance/icon and still works on its own click,
              stopping propagation so it doesn't double-toggle (fire its
              own handler, then bubble up and fire the header's again). */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
            title={collapsed ? "Expand stage" : "Collapse stage"}
            className="text-caption text-charcoal/50 hover:text-nearblack"
          >
            {collapsed ? "▸" : "▾"}
          </button>
          {renaming ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // Board reorder round — Escape now cancels (reverts the
                // draft, does NOT save) rather than being unhandled;
                // Enter still commits via blur, same as before.
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") cancelRename();
              }}
              className="flex-1 border border-nearblack bg-nearwhite px-2 py-1 text-subhead text-nearblack focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
              className="label-caps hover:opacity-70"
              style={{ color: stageColor }}
            >
              {group.name}
            </button>
          )}
          <span className="text-caption text-charcoal/40">{summaryLine}</span>
          {/* Round A "Board owns dates, Timeline is the visual" — compact
              start/end inputs, ONLY for groups linked to a phase
              (phase_id present); unlinked/legacy groups render nothing
              extra here, per this round's brief. PATCHes the linked
              phase directly (PATCH /api/phases/[id]) via
              onPatchPhaseDates, optimistic — same single-source-of-truth
              path Timeline's own phase edit panel already uses, so a
              date changed here shows up on the Timeline tab and vice
              versa without any extra sync code.

              Board v3.1 — display-first cells, item 8: when this
              group has a computed works-date range (groupWorksDateRange,
              derived above from its tasks' booking_date/booking_end_date
              — the exact same min/max the server-side rollup writes),
              show that range as READ-ONLY text with a "derived from item
              dates" tooltip instead of the manual inputs — a manual edit
              here would just be silently overwritten by the next rollup.
              Falls back to the pre-existing manual GroupPhaseDateInputs
              whenever no task in the group has works dates set yet. */}
          {group.phase_id && groupWorksDateRange && (
            <span
              className="text-caption text-charcoal/60"
              title="Derived from item dates — set works dates on individual items to change this range"
            >
              {formatShortDate(groupWorksDateRange.start_date)}
              {groupWorksDateRange.end_date !== groupWorksDateRange.start_date
                ? ` – ${formatShortDate(groupWorksDateRange.end_date)}`
                : ""}
            </span>
          )}
          {group.phase_id && !groupWorksDateRange && (
            <span onClick={(e) => e.stopPropagation()}>
              <GroupPhaseDateInputs
                startDate={group.phase_start_date}
                endDate={group.phase_end_date}
                onPatch={onPatchPhaseDates}
              />
            </span>
          )}
          {/* Timeline Day-zoom polish round — item 5's reciprocal "View
              on timeline" affordance: only shown for a group linked to a
              phase (phase_id), same gating as the date inputs above —
              an unlinked/legacy group has no Timeline row to jump to.
              FocusOnLoad (already mounted on the Timeline page) handles
              the scroll+pulse via the target row's id={`focus-phase-<id>`}
              (GanttChart.tsx's PhaseRow, this same round). */}
          {group.phase_id && (
            <a
              href={`/projects/${projectId}/timeline?focus=phase-${group.phase_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-caption text-charcoal/50 hover:text-sand"
            >
              View on timeline ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-caption text-charcoal/40 hover:text-red-700"
        >
          ✕
        </button>
      </div>
      {!collapsed && (
        <>
          <GroupRows
            tasks={group.tasks}
            columnById={columnById}
            teamById={teamById}
            team={team}
            groups={groups}
            allColumnNames={allColumnNames}
            dependencyChip={dependencyChip}
            selectedTaskIds={selectedTaskIds}
            onToggleSelect={onToggleSelect}
            onPatchTask={onPatchTask}
            onDeleteTask={onDeleteTask}
            onBookVisit={onBookVisit}
            onUnlinkVisit={onUnlinkVisit}
            onDragStartTask={onDragStartTask}
            onDropAtIndex={onDropInGroup}
            onMoveTask={onMoveTask}
            onAddSubTask={onAddSubTask}
            reconfirmPrompts={reconfirmPrompts}
            onResendConfirmation={onResendConfirmation}
            onDismissReconfirm={onDismissReconfirm}
          />
          {/* "Three from Phillip — 6 July 2026 evening" item 3: inline
              "+ Add item" composer, one per group — mirrors
              StackedColumnSection's footer composer above (same title-only
              input + Add/Cancel shape), reusing this file's single addTask()
              mutator with this group's id preset as phase_group_id (see the
              onAddTask wiring at this component's call site). Labelled
              "+ Add item" (was "+ Add task") to match this round's ITEM
              column header wording. */}
          {/* Board v3.1 — display-first cells, item 7: "add item"
              composer — already a quiet single-line input + Add/Cancel
              on one row; padding tightened slightly (py-1.5 -> py-1) to
              match this round's ~32px row rhythm. */}
          <div className="border-t border-[#e5e0d6] px-3 py-1">
            {composing ? (
              <form onSubmit={submitNewTask} className="flex gap-2">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setComposing(false)}
                  placeholder="Item title"
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
                + Add item
              </button>
            )}
          </div>
        </>
      )}
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
 *
 * UNTOUCHED by Board v3 — Monday parity round (no behaviour change).
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

/** Board v3 — Monday parity round: the "MILESTONE" chip shown next to the ◆ diamond on a milestone row's title cell — muted, sharp corners, matching every other small caption-chip in this file (e.g. AssigneeStack's initials chip). */
function MilestoneChip() {
  return (
    <span className="label-caps border border-sand/60 px-1 py-0.5 !text-sand">MILESTONE</span>
  );
}

/** Board v3 — Monday parity round: the muted "after ◆ {prev milestone}" dependency chip — display-only, no schema, no blocking (see lib/board-constants.ts's computeDependencyChips doc comment for the full derivation rule). */
function DependencyChip({ text }: { text: string }) {
  return (
    <span className="label-caps whitespace-nowrap border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50" title="Display-only — does not block creating or completing this item">
      {text}
    </span>
  );
}

// Board v3.1 — display-first cells: the native-<select>-based
// StatusPillSelect (Board v3 — Monday parity round) that used to live
// here has been REPLACED by components/board/StatusPill.tsx (a quiet
// pill at rest, popover menu of pills on click — see that file's own
// doc comment) — GroupRows' STATUS cell below now renders <StatusPill>
// instead. Removed rather than left dead, since nothing else in this
// file referenced it.

function UngroupedTable({
  tasks,
  columnById,
  teamById,
  team,
  groups,
  allColumnNames,
  selectedTaskIds,
  onToggleSelect,
  onPatchTask,
  onDeleteTask,
  onBookVisit,
  onUnlinkVisit,
  onDragStartTask,
  onDropInGroup,
  onMoveTask,
  onAddSubTask,
  reconfirmPrompts,
  onResendConfirmation,
  onDismissReconfirm,
}: {
  tasks: BoardTaskV3[];
  columnById: Map<string, BoardColumnV3>;
  teamById: Map<string, AssigneeSummary>;
  /** Board cockpit round — item 9 parity: threaded through to GroupRows' shared BoardTaskEditorBody. */
  team: AssigneeSummary[];
  groups: BoardGroupV3[];
  /** Board v3 — Monday parity round: see GroupTable's own prop of the same name. */
  allColumnNames: string[];
  /** Booking selection v2 (r24) — see GroupTable's own prop of the same name. */
  selectedTaskIds: Set<string>;
  onToggleSelect: (taskId: string) => void;
  onPatchTask: (task: BoardTaskV3, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  onDeleteTask: (task: BoardTaskV3) => void;
  /** Prefill fix: now passes the full task (was `taskId: string`) so BookVisitPanel can be preloaded with this card's own phase/trade/dates. */
  onBookVisit: (task: BoardTaskV3) => void;
  onUnlinkVisit: (taskId: string) => void;
  /** Board reorder round — same DnD/move-menu wiring as GroupTable's own props of the same names; the Ungrouped bucket is a drop target too (dropping here clears phase_group_id, same as onDropInGroup(null, ...) from the main return block's call site). */
  onDragStartTask: (taskId: string) => void;
  onDropInGroup: (index: number | null) => void;
  onMoveTask: (task: BoardTaskV3, direction: -1 | 1) => void;
  /** Board v3 — Monday parity round: see GroupTable's own prop of the same name. */
  onAddSubTask: (parentTask: BoardTaskV3, title: string) => void;
  /** Board v3.3 — see GroupTable's own prop of the same name. */
  reconfirmPrompts: Set<string>;
  onResendConfirmation: (visitId: string) => Promise<void>;
  onDismissReconfirm: (visitId: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      className={clsx("border border-dashed", dragOver ? "border-nearblack" : "border-[#c9c2b4]")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropInGroup(null);
      }}
    >
      <div className="border-b border-dashed border-[#c9c2b4] bg-transparent px-3 py-2">
        <p className="label-caps !text-charcoal/40">
          Ungrouped · {groupSummaryLine(tasks.filter((t) => !t.parent_task_id).map((t) => ({ isSubItem: false, columnName: columnById.get(t.column_id)?.name ?? "" })))}
        </p>
      </div>
      <GroupRows
        tasks={tasks}
        columnById={columnById}
        teamById={teamById}
        team={team}
        groups={groups}
        allColumnNames={allColumnNames}
        dependencyChip={null}
        selectedTaskIds={selectedTaskIds}
        onToggleSelect={onToggleSelect}
        onPatchTask={onPatchTask}
        onDeleteTask={onDeleteTask}
        onBookVisit={onBookVisit}
        onUnlinkVisit={onUnlinkVisit}
        onDragStartTask={onDragStartTask}
        onDropAtIndex={onDropInGroup}
        onMoveTask={onMoveTask}
        onAddSubTask={onAddSubTask}
        reconfirmPrompts={reconfirmPrompts}
        onResendConfirmation={onResendConfirmation}
        onDismissReconfirm={onDismissReconfirm}
      />
    </div>
  );
}

/**
 * GroupRows — Board v3 — Monday parity round rebuild. Renders one
 * stage group's (or the Ungrouped bucket's) rows: column headers
 * reading exactly "ITEM · WHO · STATUS · CONTACT · WORKS · DUE ·
 * AFTER" (BUILD-SPEC.md's exact wording — WHO = assignees, WORKS =
 * booking_date window, DUE = due_date, AFTER = the dependency chip
 * column), compact ~30px rows (`py-1` cells rather than the pre-v3
 * `py-2`), sub-item nesting with a "└" prefix glyph + "done/total"
 * count chip + collapse, milestone ◆ + "MILESTONE" chip, and a
 * row-level "Add sub-item" affordance.
 *
 * SUB-ITEM MODEL: `tasks` is FLAT (every top-level task AND every
 * sub-item for this group, exactly as the API returns it — see
 * types/board-v3.ts's "MODEL CHOICE — FLAT, not nested" doc comment
 * for why). This component does the parent/child grouping itself:
 * top-level tasks (parent_task_id === null) render as normal rows,
 * each optionally followed by its own sub-items (parent_task_id ===
 * that row's id) as additional, visually indented rows immediately
 * below it — sub-items belonging to a DIFFERENT parent never interleave
 * with the wrong parent's block, since the render walks top-level
 * tasks in order and, for each, immediately renders that parent's own
 * sub-items (in their own sort order) before moving to the next
 * top-level task.
 *
 * PRESERVES EVERY EXISTING BEHAVIOUR: inline expand-to-edit (click
 * title -> BoardTaskEditorBody, unchanged), drag reorder (row-level
 * draggable/onDrop, unchanged — sub-item rows are ALSO draggable, but
 * ProjectBoard's onDropInGroup/moveTaskWithinGroup (this file's main
 * component) both explicitly branch on `task.parent_task_id`: when
 * set, the sibling set used for the sort-ladder math is every OTHER
 * task sharing that SAME parent_task_id — never the whole group/
 * column — so a sub-item's reorder can never cross into its parent's
 * top-level row order or into a different parent's sub-items, per
 * BUILD-SPEC.md's exact rule), due date editing (unchanged), status <select> (now rendered via
 * StatusPillSelect for the coloured-pill visual, same underlying
 * <select>/onChange), phase <select> (unchanged, top-level tasks
 * only — a sub-item's phase is inherited and not independently
 * editable from this row, consistent with "sub-items inherit
 * phase_group from parent"), Move up/down touch fallback (unchanged),
 * booking badge text (unchanged).
 */
function GroupRows({
  tasks,
  columnById,
  teamById,
  team,
  groups,
  allColumnNames,
  dependencyChip,
  selectedTaskIds,
  onToggleSelect,
  onPatchTask,
  onDeleteTask,
  onBookVisit,
  onUnlinkVisit,
  onDragStartTask,
  onDropAtIndex,
  onMoveTask,
  onAddSubTask,
  reconfirmPrompts,
  onResendConfirmation,
  onDismissReconfirm,
}: {
  tasks: BoardTaskV3[];
  columnById: Map<string, BoardColumnV3>;
  teamById: Map<string, AssigneeSummary>;
  /** Board cockpit round — item 9 parity: full assignee roster, needed by the shared BoardTaskEditorBody's "Assigned" checklist when a row expands. */
  team: AssigneeSummary[];
  groups: BoardGroupV3[];
  /** Board v3 — Monday parity round: every status column's name on this board, for the booking soft-mapping's /booked/i check. */
  allColumnNames: string[];
  /** Board v3 — Monday parity round: "after ◆ {prev milestone}" chip text to show on the FIRST non-milestone TOP-LEVEL row, or null. */
  dependencyChip: string | null;
  /** Booking selection v2 (r24) — item 1: this row's own edge checkbox state/toggle — see ProjectBoard's selectedTaskIds doc comment. */
  selectedTaskIds: Set<string>;
  onToggleSelect: (taskId: string) => void;
  onPatchTask: (task: BoardTaskV3, patch: Record<string, unknown>, refUpdate?: Partial<BoardTaskV3>) => void;
  /** Board cockpit round — item 9 parity: "Remove card" action, matching kanban's BoardCard. */
  onDeleteTask: (task: BoardTaskV3) => void;
  /** Board cockpit round — item 9 parity: opens ProjectBoard's shared BookVisitPanel for this row's task. Prefill fix: now passes the full task (was `taskId: string`) so BookVisitPanel can be preloaded with this card's own phase/trade/dates — this is the Grouped-list row path, the daily-driver/mobile view where the blank-prefill bug was most visible. */
  onBookVisit: (task: BoardTaskV3) => void;
  /** Board cockpit round — item 9 parity: unlinks (does not delete) this row's booked visit. */
  onUnlinkVisit: (taskId: string) => void;
  /** Board reorder round — row is draggable; dragstart records this task's id in the parent's dragTaskId state (same as StackedColumnSection's rows). */
  onDragStartTask: (taskId: string) => void;
  /** Board reorder round — a drop ON a specific row inserts the dragged task at that row's index (stopPropagation so the group wrapper's own onDrop, which appends at the end, doesn't also fire). */
  onDropAtIndex: (index: number) => void;
  /** Board reorder round — touch fallback's "Move up"/"Move down", per row. */
  onMoveTask: (task: BoardTaskV3, direction: -1 | 1) => void;
  /** Board v3 — Monday parity round: row-level "Add sub-item" — see GroupTable's own prop of the same name. */
  onAddSubTask: (parentTask: BoardTaskV3, title: string) => void;
  /** Board v3.3 — visit ids currently showing the "Dates changed — re-send confirmation?" affordance (ProjectBoard's own reconfirmPrompts state), surfaced below the WORKS cell for any row whose visit_id is in this set — see WorksDateCell/PATCH /api/board-tasks/[id]'s own doc comments for when this gets populated. */
  reconfirmPrompts: Set<string>;
  onResendConfirmation: (visitId: string) => Promise<void>;
  onDismissReconfirm: (visitId: string) => void;
}) {
  // Board cockpit round — item 9 "Grouped-list edit parity": clicking a
  // row expands the SAME full card editor component the kanban view
  // uses (BoardTaskEditorBody), instead of only exposing due/status/
  // phase as bare inline cells. Local expand state + a lazy contacts
  // fetch on first expand — same shape as BoardCard's own expanded/
  // contacts state, just owned per-row here instead of per-card.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  // Board v3.1 — display-first cells, item 4: whether the CONTACT
  // cell's click-to-reveal picker (PopoverCell) has been opened at
  // least once for this group's rows yet — used only to trigger the
  // lazy contacts fetch below (same "fetch once, on first need" shape
  // the row-expand editor already had for `contacts`) independently of
  // a row being expanded, since the contact picker is now reachable
  // WITHOUT expanding a row.
  const [contactPopoverOpened, setContactPopoverOpened] = useState(false);
  // Board v3 — Monday parity round: which parent row's sub-items are
  // collapsed (hidden) — a Set of parent task ids, defaults to empty
  // (every parent starts EXPANDED, showing its sub-items, consistent
  // with GroupTable's own "starts open" default for the whole stage).
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  // Board v3 — Monday parity round: which parent row's "Add sub-item"
  // inline composer is open.
  const [addingSubItemFor, setAddingSubItemFor] = useState<string | null>(null);
  const [subItemTitle, setSubItemTitle] = useState("");
  // Board v3.2 — "Reorder slot animation": while a row is being dragged
  // over this group's rows, `dragOverIndex` records WHICH sibling list
  // the gap should open in (`listKey`: "top" for the top-level task
  // list, or a parent task's own id for that parent's sub-item list —
  // a sub-item can only ever open a gap among its OWN siblings, same
  // "never across parents or up to top level" rule onDropInGroup/
  // moveTaskWithinGroup already enforce server-side) and at WHICH index
  // within that list (matching the exact index onDropAtIndex will be
  // called with on drop, so the visual gap and the actual drop target
  // are always the same position — see renderRow's onDragOver below).
  // null when nothing is being dragged over this group at all.
  const [dragOverIndex, setDragOverIndex] = useState<{ listKey: string; index: number } | null>(null);
  // Board v3.2 — which row id is currently playing the brief on-drop
  // "settle" transform-ease (BUILD-SPEC.md "on drop the row settles
  // with a brief transform ease") — set on drop, cleared automatically
  // after REORDER_GAP_MS * 2 via the timeout below. A single id (not a
  // Set) since only the just-dropped row plays this animation, never
  // more than one at a time.
  const [settlingId, setSettlingId] = useState<string | null>(null);

  function clearDragOver() {
    setDragOverIndex(null);
  }

  /**
   * Board v3.2 — called from renderRow's onDrop, right before the
   * existing onDropAtIndex(siblingIndex) call that actually persists
   * the reorder — clears the gap immediately (the drop is about to
   * re-render this list in its new order anyway) and flags the dropped
   * row for the brief settle animation, auto-clearing after it plays
   * once. Purely cosmetic — never touches sort/persistence, which
   * onDropAtIndex (unchanged) still owns entirely.
   */
  function playSettleAnimation(taskId: string) {
    setDragOverIndex(null);
    setSettlingId(taskId);
    setTimeout(() => setSettlingId((cur) => (cur === taskId ? null : cur)), REORDER_GAP_MS * 2);
  }

  /**
   * Board v3.2 — the translateY offset (px, as a CSS transform string)
   * this row should render with RIGHT NOW: rows at/after the open gap's
   * index within the SAME sibling list (`listKey` match) translate one
   * row-height in the drag direction to visually open a slot for the
   * dragged row to land in. Returns "" (no transform) for a list that
   * isn't the one currently being dragged over, or for a row before the
   * gap — this is pure presentation, computed fresh every render from
   * dragOverIndex, never mutating row order itself (the actual array
   * order only ever changes after the server round-trip resolves, via
   * the existing onDropAtIndex/updateTaskField path).
   */
  function gapTransform(listKey: string, indexInList: number): string {
    if (!dragOverIndex || dragOverIndex.listKey !== listKey) return "";
    if (indexInList < dragOverIndex.index) return "";
    return `translateY(${REORDER_ROW_PX}px)`;
  }

  useEffect(() => {
    if (!expandedId && !contactPopoverOpened) return;
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, [expandedId, contactPopoverOpened]);

  if (tasks.length === 0) {
    return <p className="px-3 py-3 text-caption text-charcoal/40">No cards yet.</p>;
  }

  const columnOptions = [...columnById.values()];

  // Board v3 — Monday parity round: split into top-level tasks (this
  // group's own row order, unchanged from before this round) and a
  // lookup of sub-items BY parent id (each parent's own sub-items kept
  // in their existing sort order, exactly as the API/state already
  // orders `tasks`).
  const topLevelTasks = tasks.filter((t) => !t.parent_task_id);
  const subItemsByParent = new Map<string, BoardTaskV3[]>();
  for (const t of tasks) {
    if (!t.parent_task_id) continue;
    const list = subItemsByParent.get(t.parent_task_id) ?? [];
    list.push(t);
    subItemsByParent.set(t.parent_task_id, list);
  }

  // Board v3 — Monday parity round: the dependency chip, per spec,
  // shows on the FIRST NON-MILESTONE TOP-LEVEL row — find its id once
  // so the render loop below can check `task.id === firstNonMilestoneId`.
  const firstNonMilestoneId = topLevelTasks.find((t) => t.kind !== "milestone")?.id ?? null;

  function submitSubItem(parentTask: BoardTaskV3, e: React.FormEvent) {
    e.preventDefault();
    if (!subItemTitle.trim()) return;
    onAddSubTask(parentTask, subItemTitle.trim());
    setSubItemTitle("");
    setAddingSubItemFor(null);
  }

  function toggleParentCollapsed(parentId: string) {
    setCollapsedParents((cur) => {
      const next = new Set(cur);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  /** One row — shared by both top-level tasks and sub-items, differing only in indentation/prefix/count-chip/context-menu contents. `topLevelIndex` is this row's position among ITS OWN sibling set (top-level tasks for a top-level row, or this parent's sub-items for a sub-item row) — used for the Move up/down disabled-at-ends check and drag-drop index, so a sub-item's reorder is scoped to its own sibling set exactly as BUILD-SPEC.md requires ("never across parents or up to top level"). */
  function renderRow(task: BoardTaskV3, siblingIndex: number, siblingCount: number, isSubItem: boolean) {
    const isExpanded = expandedId === task.id;
    const column = columnById.get(task.column_id);
    const columnName = column?.name ?? "";
    // A done task can't be overdue, and its due date is no longer
    // relevant to show — Phillip 10 Jul: "the due date should be
    // removed if the item is set to done". The underlying due_date
    // value is untouched in the DB (see the DueDateCell call below),
    // this only masks the DISPLAY while the task sits in a Done-named
    // column; it reappears correctly if the task is moved back out.
    const isDone = isDoneColumnName(columnName);
    // migration 041 — datetime-aware once due_time is set, else the
    // original date-only rule (see isOverdueByDateTime's own doc
    // comment for the full "why datetime, not date+Date-object" story).
    const pastDue = !isDone && isOverdueByDateTime(task.due_date, task.due_time);
    const tint = resolveStatusPillTint(columnName, task.visit?.status ?? null, allColumnNames);
    const children = subItemsByParent.get(task.id) ?? [];
    const isParentCollapsed = collapsedParents.has(task.id);
    const showDependencyChip = !isSubItem && task.id === firstNonMilestoneId ? dependencyChip : null;
    // Board v3.2 — "Reorder slot animation": this row's own sibling-list
    // key — "top" for a top-level row, or its OWN parent's id for a
    // sub-item row (every sub-item row IS its parent's own sibling
    // list — see gapTransform's doc comment for why this must match
    // onDropInGroup/moveTaskWithinGroup's identical "same
    // parent_task_id" sibling-set rule). Used to scope the open-gap
    // transform + drop-line to exactly the list this row belongs to,
    // so dragging within one parent's sub-items never visually shifts
    // a different parent's rows (or the top-level list).
    const listKey = isSubItem ? (task.parent_task_id as string) : "top";
    const showDropLineBefore = dragOverIndex?.listKey === listKey && dragOverIndex.index === siblingIndex;
    const isLastInList = siblingIndex === siblingCount - 1;
    const showDropLineAfter =
      isLastInList && dragOverIndex?.listKey === listKey && dragOverIndex.index === siblingCount;

    return (
      <Fragment key={task.id}>
        {/* Board v3.2 — 2px sand drop-line, rendered as its own
            zero-height row directly above the row a drop would insert
            before (or, when the gap is at the very end of this list,
            above the closing "+ Add sub-item"/composer area — handled
            via showDropLineAfter just below the last row instead).
            Purely visual: this line's presence/position is derived
            100% from dragOverIndex state, never read by the actual
            drop handler (onDropAtIndex, unchanged, still keys off
            `siblingIndex` alone). */}
        {showDropLineBefore && (
          <tr aria-hidden className="h-0">
            <td colSpan={8} className="p-0">
              <div className="h-[2px] bg-sand" />
            </td>
          </tr>
        )}
        <tr
          id={`focus-board_task-${task.id}`}
          draggable
          onClick={() => setExpandedId(isExpanded ? null : task.id)}
          onDragStart={() => onDragStartTask(task.id)}
          // Board v3.2 — dragend fires on the DRAG SOURCE once the
          // gesture ends, whether it was dropped successfully, dropped
          // somewhere that doesn't accept it, or cancelled (Escape/
          // dropped outside any valid target) — the one reliable place
          // to guarantee the gap always closes, since onDrop only fires
          // on a successful drop and onDragLeave can fire/re-fire
          // repeatedly while crossing sibling rows within the same
          // list (see the table wrapper's own onDragLeave for the
          // "left the table entirely" fallback).
          onDragEnd={clearDragOver}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Board v3.2 — which half of this row the pointer is over
            // decides whether the gap opens BEFORE this row (index =
            // siblingIndex) or AFTER it (index = siblingIndex + 1, only
            // reachable this way for the last row in the list — every
            // other "after row N" position is already "before row
            // N+1"). This mirrors onDropAtIndex's own existing
            // semantics (a drop always inserts "at" a row's index)
            // exactly — the animation never introduces a drop position
            // the pre-existing drop math doesn't already support.
            //
            // IMPORTANT: getBoundingClientRect() reports THIS row's
            // CURRENT rendered position — if this row already has
            // gapTransform's translateY applied (it's at/after an
            // already-open gap from a PREVIOUS dragover tick), its
            // reported rect.top is shifted by REORDER_ROW_PX from
            // where it sits in normal document flow. Hit-testing
            // against that shifted rect directly would make the
            // gap/drop-line drift out of sync with the actual cursor
            // position as the drag progresses (a transform never moves
            // OTHER rows' layout boxes, only this element's own
            // reported rect) — so the shift is subtracted back out
            // before computing the midpoint, recovering this row's
            // stable, untransformed layout position for the hit-test.
            const currentTransform = gapTransform(listKey, siblingIndex);
            const rect = e.currentTarget.getBoundingClientRect();
            const untransformedTop = currentTransform ? rect.top - REORDER_ROW_PX : rect.top;
            const overSecondHalf = e.clientY - untransformedTop > rect.height / 2;
            const index = overSecondHalf && isLastInList ? siblingIndex + 1 : siblingIndex;
            setDragOverIndex((cur) =>
              cur?.listKey === listKey && cur.index === index ? cur : { listKey, index }
            );
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const dropIndex = dragOverIndex?.listKey === listKey ? dragOverIndex.index : siblingIndex;
            playSettleAnimation(task.id);
            onDropAtIndex(dropIndex);
          }}
          className={clsx(
            // Board v3.1 — display-first cells, item 3: row height
            // tightened to ~32px (was 30px); hairline divider reuses
            // the existing charcoal brand token at ~10% opacity
            // (border-charcoal/10) rather than a new colour literal —
            // subtle, per this round's brief. No zebra/alternating-row
            // background exists in this table (confirmed: only a
            // hover state and a distinct isSubItem tint, neither of
            // which alternates by row index) — nothing to turn off.
            "h-8 cursor-move border-b border-charcoal/10 last:border-b-0 hover:bg-nearwhite",
            isSubItem && "bg-nearwhite/60",
            // Board v3.2 — reorder slot animation: neighbouring rows
            // translate apart via a CSS transform (never a layout
            // property — see gapTransform's own doc comment for the
            // "no layout thrash" rationale) with a ~120ms ease-out
            // while a gap is open; the just-dropped row instead plays a
            // brief settle ease (transition-transform duration-150
            // ease-in, per BUILD-SPEC.md "brief transform ease"). Both
            // classes are mutually exclusive in practice (settlingId is
            // only ever set right as dragOverIndex clears on drop) but
            // are written as independent conditionals rather than an
            // either/or for clarity.
            dragOverIndex && "transition-transform duration-[120ms] ease-out",
            settlingId === task.id && "transition-transform duration-150 ease-in"
          )}
          style={{ transform: gapTransform(listKey, siblingIndex) || undefined }}
        >
          <td className="py-1 pl-3 pr-1" onClick={(e) => e.stopPropagation()}>
            {/* Booking selection v2 (r24) — item 1: row-edge checkbox,
                phase-card item rows (both top-level and sub-item rows —
                each is its own board_task, individually bookable).
                Feeds the action bar / GroupBookPanel seed, never the
                row's own expand-on-click or drag. */}
            <input
              type="checkbox"
              checked={selectedTaskIds.has(task.id)}
              onChange={() => onToggleSelect(task.id)}
              className="h-3.5 w-3.5"
            />
          </td>
          <td className="py-1 pl-1 pr-3 text-body text-nearblack">
            {/* Board v3.1 — display-first cells, item 3: nowrap +
                min-w-0 (was flex-wrap) so a long title ellipsis-
                truncates in this ~32px single-line row instead of
                wrapping to a second line or pushing the row taller —
                the full title is still available via TaskTitleInline's
                own `title` HTML attribute (hover tooltip) when
                `truncate` is set below. */}
            <span className="flex flex-nowrap items-center gap-1.5 min-w-0">
              {/* Board v3 — Monday parity round: sub-item indentation —
                  a literal "└" prefix glyph, per BUILD-SPEC.md's own
                  "Skirtings installation 2" example. */}
              {isSubItem && <span className="shrink-0 text-charcoal/40">└</span>}
              {!isSubItem && children.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleParentCollapsed(task.id);
                  }}
                  title={isParentCollapsed ? "Show sub-items" : "Hide sub-items"}
                  className="shrink-0 text-caption text-charcoal/40 hover:text-nearblack"
                >
                  {isParentCollapsed ? "▸" : "▾"}
                </button>
              )}
              {task.kind === "milestone" && <span className="shrink-0"><MilestoneDiamond /></span>}
              <TaskTitleInline
                title={task.title}
                onPatch={(patch, refUpdate) => onPatchTask(task, patch, refUpdate)}
                truncate
              />
              {/* Review fix, grouped trade booking round (r20): BUILD-
                  SPEC.md item 4's "suggestion -> attention/daily-brief
                  item + project board badge" only had the daily-brief
                  half wired in — a trade suggesting a different date
                  was otherwise invisible on the board itself. Pure
                  indicator, not a link (resolving which trade_booking_
                  requests row to open would need booking_request_id,
                  not carried on LinkedVisitSummary) — see Daily Brief
                  or /trade-requests/[id] to actually act on it. */}
              {task.visit?.line_status === "date_suggested" && (
                <span
                  title="This trade suggested a different date for this line — see Daily Brief or the trade request to accept or decline."
                  className="shrink-0 border border-amber-700/40 bg-amber-50 px-1.5 py-0.5 text-caption text-amber-800"
                >
                  Date suggested
                </span>
              )}
              {/* Bug fix, 8 July 2026: the whole row is now the click
                  target for expand/collapse (onClick on the <tr> above)
                  — was previously only this small chevron. Kept as an
                  explicit visual affordance/icon, stopping propagation
                  so it doesn't double-toggle (fire its own handler, then
                  bubble up and fire the row's again). */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedId(isExpanded ? null : task.id);
                }}
                title="Expand to edit description, assignees, due date & more"
                className="shrink-0 text-caption text-charcoal/40 hover:text-sand"
              >
                {isExpanded ? "▴" : "▾"}
              </button>
              {task.kind === "milestone" && <span className="shrink-0"><MilestoneChip /></span>}
              {/* Board v3 — Monday parity round: sub-item count chip —
                  "done/total" e.g. "2/3", a PURE DISPLAY SUMMARY of
                  children. IMPORTANT DEVIATION FROM A LOOSE READING (per
                  BUILD-SPEC.md): this chip does NOT change the parent's
                  own completed/not-completed status — there is no
                  auto-rollup anywhere in this codebase's write paths;
                  the parent's own column_id is only ever changed by the
                  parent's OWN Status select, never derived from its
                  children. */}
              {!isSubItem && children.length > 0 && (
                <span
                  className="label-caps shrink-0 border border-[#c9c2b4] px-1 py-0.5 !text-charcoal/50"
                  title="Sub-items complete / total — a display summary only, does not affect this item's own status"
                >
                  {subItemCountChip(
                    children.map((c) => ({ columnName: columnById.get(c.column_id)?.name ?? "" }))
                  )}
                </span>
              )}
            </span>
          </td>
          <td className="py-1 pr-3" onClick={(e) => e.stopPropagation()}>
            {/* Board v3.1 — display-first cells, item 4: WHO — quiet
                avatar stack at rest; click opens the SAME checkbox
                picker the kanban composer/editor already uses
                (AssigneeMultiPicker), via the shared PopoverCell
                click-to-reveal wrapper.
                Bug fix, 8 July 2026: this <td> stops click propagation
                (row-level onClick now toggles expand/collapse) so
                opening this picker never also collapses the row. */}
            <PopoverCell
              trigger={
                task.assignees.length > 0 ? (
                  <AssigneeStack assignees={task.assignees} />
                ) : (
                  <span className="text-caption text-charcoal/40">—</span>
                )
              }
              triggerTitle="Click to change who's assigned"
            >
              {() => (
                <AssigneeMultiPicker
                  team={team}
                  selected={task.assignees.map((a) => a.id)}
                  onChange={(ids) =>
                    onPatchTask(
                      task,
                      { assignee_ids: ids },
                      { assignees: ids.map((id) => teamById.get(id)).filter((p): p is AssigneeSummary => !!p) }
                    )
                  }
                />
              )}
            </PopoverCell>
          </td>
          <td className="py-1 pr-3" onClick={(e) => e.stopPropagation()}>
            {/* Board v3.1 — display-first cells, item 1: STATUS — quiet
                coloured pill at rest; click opens a popover menu of
                every valid column, same underlying column_id PATCH the
                pre-v3.1 native <select> (StatusPillSelect) already
                called. Bug fix, 8 July 2026: stops propagation so
                opening this popover never also collapses the row. */}
            <StatusPill
              value={task.column_id}
              columnOptions={columnOptions}
              tint={tint}
              onChange={(columnId) => {
                if (columnId !== task.column_id) onPatchTask(task, { column_id: columnId }, { column_id: columnId });
              }}
            />
          </td>
          <td className="py-1 pr-3 text-caption text-charcoal/60" onClick={(e) => e.stopPropagation()}>
            {/* Board v3.1 — display-first cells, item 4: CONTACT — quiet
                company name (or "—") at rest; click opens the shared
                ContactPicker (embedded mode) to change it.
                Bug fix, 8 July 2026: stops propagation so opening this
                picker never also collapses the row. */}
            <PopoverCell
              trigger={task.contact?.company ?? "—"}
              triggerTitle="Click to change linked contact"
              onOpen={() => setContactPopoverOpened(true)}
            >
              {(close) => (
                <ContactPicker
                  embedded
                  contacts={contacts}
                  selectedId={task.contact_id}
                  onClose={close}
                  onSelect={(contactId) => {
                    const contact = contactId ? contacts.find((c) => c.id === contactId) ?? null : null;
                    onPatchTask(
                      task,
                      { contact_id: contactId },
                      { contact: contact ? { id: contact.id, company: contact.company, contact_name: contact.contact_name } : null }
                    );
                    close();
                  }}
                />
              )}
            </PopoverCell>
          </td>
          <td className="py-1 pr-3" onClick={(e) => e.stopPropagation()}>
            {/* Board v3.3 — WORKS is now a genuine editable start/end
                popover (booking_date/booking_end_date REJOINED PATCH
                /api/board-tasks/[id]'s whitelist — see that route's
                EDITABLE_FIELDS doc comment) — reverses v3.1's read-only
                treatment, which used to open the Book-trade panel from
                this exact cell. "Book trade" remains reachable ONLY via
                its own explicit buttons (BoardTaskEditorBody's Book
                trade/Unlink actions below, kanban card, context menu) —
                this cell only ever edits dates on whatever booking state
                already exists (none, or a live visit_id link). Bug fix,
                8 July 2026: stops propagation so opening this popover
                never also collapses the row. */}
            <WorksDateCell
              startDate={task.booking_date}
              endDate={task.booking_end_date}
              visitId={task.visit_id}
              visitStatusLabel={task.visit ? BOOKING_STATUS_LABEL[task.visit.status] : null}
              onCommit={(next) => onPatchTask(task, next, next)}
            />
          </td>
          <td className="py-1 pr-3" onClick={(e) => e.stopPropagation()}>
            {/* Board v3.1 — display-first cells, item 2: DUE — quiet
                display chip ("14 Jul" / "—") at rest; click swaps to a
                real date input. Commits via the SAME onPatchTask
                due_date PATCH the pre-v3.1 always-visible input already
                called. Bug fix, 8 July 2026: stops propagation so
                opening this input never also collapses the row. */}
            <DueDateCell
              value={isDone ? null : task.due_date}
              timeValue={isDone ? null : task.due_time}
              pastDue={pastDue}
              onCommit={(next) => onPatchTask(task, next, next)}
            />
          </td>
          <td className="py-1 pr-3">
            {showDependencyChip && <DependencyChip text={showDependencyChip} />}
          </td>
        </tr>
        {/* Board v3.3 — "Dates changed — re-send confirmation?" — shown
            right under a row whose linked visit was CONFIRMED at the
            moment a direct works-date edit (WorksDateCell above, or any
            other booking_date/booking_end_date PATCH) moved its dates.
            Same shared ReconfirmAffordance component GanttChart.tsx's
            visit sub-bars already use, keyed by visit id (not task id)
            for consistency with that file's own convention. */}
        {task.visit_id && reconfirmPrompts.has(task.visit_id) && (
          <tr className="border-b border-[#e5e0d6] last:border-b-0">
            <td colSpan={8} className="px-3 pb-1.5">
              <ReconfirmAffordance
                onResend={() => onResendConfirmation(task.visit_id as string)}
                onDismiss={() => onDismissReconfirm(task.visit_id as string)}
              />
            </td>
          </tr>
        )}
        {isExpanded && (
          <tr className="border-b border-[#e5e0d6] bg-nearwhite last:border-b-0">
            <td colSpan={8} className="px-3 pb-3">
              <BoardTaskEditorBody
                task={task}
                team={team}
                teamById={teamById}
                contacts={contacts}
                onPatch={(patch, refUpdate) => onPatchTask(task, patch, refUpdate)}
                onDelete={() => onDeleteTask(task)}
                onBookVisit={() => onBookVisit(task)}
                onUnlinkVisit={() => onUnlinkVisit(task.id)}
              />
              {/* Board v3 — Monday parity round: Move up/down — moved
                  out of a separate visible column per this round's
                  denser ~30px row height, into the expanded editor
                  alongside the other per-row actions (to keep the
                  compact row itself to the 7 spec'd columns only).
                  Offered for BOTH top-level rows and sub-item rows —
                  `onMoveTask` (ProjectBoard's moveTaskWithinGroup) is
                  itself parent_task_id-aware, so a sub-item's Move
                  up/down only ever reorders among its own siblings
                  (see that function's own doc comment). `siblingIndex`/
                  `siblingCount` were already computed against the
                  correct sibling set by this row's own caller (either
                  the top-level tasks array or this parent's `children`
                  array), so the disabled-at-ends check is correct for
                  both row kinds without any extra branching here. */}
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[#dcd6cc] pt-2">
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => onMoveTask(task, -1)}
                    disabled={siblingIndex === 0}
                    title="Move up"
                    className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal/60 hover:border-nearblack disabled:opacity-30"
                  >
                    ↑ Move up
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveTask(task, 1)}
                    disabled={siblingIndex === siblingCount - 1}
                    title="Move down"
                    className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal/60 hover:border-nearblack disabled:opacity-30"
                  >
                    ↓ Move down
                  </button>
                </div>
                {/* Board v3 — Monday parity round: Phase re-assignment
                    and "Add sub-item" are TOP-LEVEL-ONLY affordances —
                    a sub-item's phase is inherited from its parent (not
                    independently editable, per BUILD-SPEC.md), and
                    "Add sub-item" is one-level-of-nesting-only (a
                    sub-item cannot itself have sub-items, matching the
                    API's own depth guard). */}
                {!isSubItem && (
                  <>
                    <label className="flex flex-col gap-0.5">
                      <span className="label-caps !text-charcoal/40">Phase</span>
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
                    </label>
                    {addingSubItemFor === task.id ? (
                      <form onSubmit={(e) => submitSubItem(task, e)} className="flex gap-2">
                        <input
                          autoFocus
                          value={subItemTitle}
                          onChange={(e) => setSubItemTitle(e.target.value)}
                          onKeyDown={(e) => e.key === "Escape" && setAddingSubItemFor(null)}
                          placeholder="Sub-item title"
                          className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
                        />
                        <button type="submit" className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">
                          Add
                        </button>
                        <button type="button" onClick={() => { setAddingSubItemFor(null); setSubItemTitle(""); }} className="text-caption text-charcoal/50 hover:text-nearblack">
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAddingSubItemFor(task.id)}
                        className="border border-dashed border-[#c9c2b4] px-2 py-1 text-caption text-charcoal/60 hover:border-nearblack hover:text-nearblack"
                      >
                        + Add sub-item
                      </button>
                    )}
                  </>
                )}
              </div>
            </td>
          </tr>
        )}
        {!isSubItem && !isParentCollapsed && children.map((child, i) => renderRow(child, i, children.length, true))}
        {/* Board v3.2 — drop-line for a gap opened AFTER the last row
            in this sibling list (dragging past the bottom of the
            list) — see showDropLineAfter's own definition above. */}
        {showDropLineAfter && (
          <tr aria-hidden className="h-0">
            <td colSpan={8} className="p-0">
              <div className="h-[2px] bg-sand" />
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  return (
    <table
      className="w-full table-fixed text-left"
      // Board v3.2 — fallback for "drag left the table entirely
      // without dropping" (e.g. dragged out to another group/section) —
      // relatedTarget is null/outside the table in that case; a
      // dragleave fired while moving BETWEEN this table's own rows has
      // relatedTarget still inside the table, so it's ignored (each
      // row's own onDragOver already re-sets dragOverIndex on the very
      // next dragover tick, so this check only needs to catch the
      // "actually left" case, not every intra-table micro-transition).
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          clearDragOver();
        }
      }}
    >
      <thead>
        {/* Board v3 — Monday parity round: exact column-header text per
            BUILD-SPEC.md — "ITEM · WHO · STATUS · CONTACT · WORKS ·
            DUE · AFTER".
            Bug fix, 8 July 2026: table-fixed distributes width equally
            across <th> elements with no explicit width — fine at 4-5
            columns, but v3.1's new WORKS column (plus DUE's longer
            "· book by" label) pushed ITEM down to the same cramped
            width as narrow utility columns like WHO/STATUS/DUE, badly
            truncating task titles. Explicit percentage widths below
            give ITEM (the actual content column) the lion's share,
            narrow columns (WHO/STATUS/DUE) only what a pill/avatar/date
            needs, and CONTACT/WORKS/AFTER enough for their longer text
            (company names, "15 Jul · Unconfirmed", dependency chips)
            without starving ITEM again. */}
        <tr className="border-b border-[#e5e0d6] text-caption text-charcoal/40">
          {/* Booking selection v2 (r24) — item 1: row-edge checkbox
              header column — no label, matches the row cell's own
              plain checkbox (no "select all" affordance this round). */}
          <th className="w-[4%] py-1.5 pl-3 pr-1 font-normal" />
          <th className="w-[26%] py-1.5 pl-1 pr-3 font-normal">ITEM</th>
          <th className="w-[7%] py-1.5 pr-3 font-normal">WHO</th>
          <th className="w-[10%] py-1.5 pr-3 font-normal">STATUS</th>
          <th className="w-[12%] py-1.5 pr-3 font-normal">CONTACT</th>
          <th className="w-[13%] py-1.5 pr-3 font-normal">WORKS</th>
          {/* Board v3.1 — display-first cells, item 9: "DUE" keeps its
              exact BUILD-SPEC.md label, with a subtle secondary hint
              ("· book by") in muted/smaller styling right next to it —
              never louder than the column label itself. */}
          <th className="w-[10%] py-1.5 pr-3 font-normal">
            DUE <span className="text-charcoal/30">· book by</span>
          </th>
          <th className="w-[18%] py-1.5 pr-3 font-normal">AFTER</th>
        </tr>
      </thead>
      <tbody>{topLevelTasks.map((task, index) => renderRow(task, index, topLevelTasks.length, false))}</tbody>
    </table>
  );
}

// ------------------------------------------------------------
// "Update status names" panel — Board v3.1 — display-first cells,
// item 6. Opened from the board's "..." overflow menu (see the main
// return block above). One text input per status column, prefilled
// with a best-guess old-vocabulary -> new-vocabulary mapping
// (lib/board-constants.ts's suggestStatusColumnName — "waiting"/
// "to do" -> "Not Booked", "in progress" -> "In Progress", "done" ->
// "Done", "booked" -> "Booked"; any column name that doesn't match one
// of those old labels is prefilled with its OWN current name
// unchanged, so a team's custom column names are never silently
// clobbered by a fabricated suggestion). The user can freely edit any
// of the prefilled values before Save.
//
// Save renames ONLY the columns whose draft differs from the column's
// current name, via onRenameColumn (ProjectBoard's existing
// renameColumn(), which itself PATCHes the EXISTING
// /api/board-columns/[id] route — same "PATCH updates name/sort only,
// id/task associations untouched" behaviour every other column rename
// in this app already uses). No new endpoint, no migration — this
// panel is pure client-side UI + the existing rename call, run once
// per changed column.
// ------------------------------------------------------------

function UpdateStatusNamesPanel({
  columns,
  onRenameColumn,
  onClose,
}: {
  columns: BoardColumnV3[];
  onRenameColumn: (columnId: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(columns.map((c) => [c.id, suggestStatusColumnName(c.name)]))
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const changed = columns.filter((c) => drafts[c.id]?.trim() && drafts[c.id].trim() !== c.name);
      for (const c of changed) {
        await onRenameColumn(c.id, drafts[c.id].trim());
      }
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not update status names.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-nearblack/30 px-4">
      <div className="w-full max-w-md border border-[#dcd6cc] bg-cream p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-subhead text-nearblack">Update status names</p>
          <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
            Close
          </button>
        </div>
        <p className="mb-3 text-caption text-charcoal/60">
          Best-guess new labels are prefilled below — adjust any of them before saving. Renaming keeps every
          card&apos;s status intact (only the label changes).
        </p>
        <div className="space-y-2">
          {columns.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-caption text-charcoal/50" title={`Current: ${c.name}`}>
                {c.name}
              </span>
              <input
                value={drafts[c.id] ?? c.name}
                onChange={(e) => setDrafts((cur) => ({ ...cur, [c.id]: e.target.value }))}
                className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
          ))}
        </div>
        {saveError && <p className="mt-2 text-caption text-red-700">{saveError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="border border-nearblack bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
