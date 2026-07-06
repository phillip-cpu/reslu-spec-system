"use client";

// ============================================================
// Timeline v2 (Phase 11A) — rendering decision, documented per the
// build spec:
//
// A schedule_phases row can now hold MANY trade_visits. Rather than
// inventing a new multi-row-per-phase grid layout (which would break
// the existing one-row-per-phase CSS grid math this file and
// lib/gantt.ts already share with the read-only portal mirror), each
// phase row keeps its single bar, with a COMPACT overview strip of
// small status dots (one per visit, see components/gantt/VisitBar.tsx)
// rendered just below/alongside the bar. The FULL detail for each
// visit — contact, dates, arrival, status, edit/delete — lives in the
// phase's EXISTING expand-on-click edit panel (PhaseEditPanel below),
// which already exists as a col-span-full row beneath the phase row.
// This reuses an interaction pattern staff already know (click phase
// name to expand) instead of adding a second one, and keeps
// lib/gantt.ts's row-per-phase grid math completely untouched — visits
// never need their own grid row, only their own grid-position
// coordinates within the shared week grid (see lib/gantt.ts's
// visitGridPosition, used inside the edit panel's per-visit list, and
// the compact dots above, which don't need grid coordinates at all
// since they're laid out as a simple flex strip, not positioned bars).
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Contact, PhaseColorKey } from "@/types";
import type { SchedulePhaseWithVisits, TradeVisitWithContact, ArrivalSlot } from "@/lib/trade-visits";
import { formatArrival } from "@/lib/trade-visits";
import {
  computeGanttGrid,
  isNewMonth,
  monthLabel,
  phaseGridPosition,
  todayGridPosition,
  type GanttGrid,
} from "@/lib/gantt";
import { applyDrag, snapDeltaDays, type DragMode } from "@/lib/phase-drag";
import { VisitBar, VisitStatusLabel } from "./VisitBar";
import { VisitSubBar } from "./VisitSubBar";
import { ReconfirmAffordance } from "./ReconfirmAffordance";
import { UmbrellaBand } from "./UmbrellaBand";
import { CompletedPhasesGroup } from "./CompletedPhasesGroup";
import { VisitBottomSheet } from "./VisitBottomSheet";
import { ContextMenu, type ContextMenuItem } from "@/components/shared/ContextMenu";
import { ContactPicker } from "@/components/shared/ContactPicker";
import type { GanttTimelineMarker } from "@/types/board-cockpit";
import type { VisitExpansionState } from "@/types/round-c";

/** Pixel width of the invisible edge zone at each end of a bar that resizes instead of moves — BUILD-SPEC "grab 6px edge zones = resize start or end". */
const EDGE_ZONE_PX = 6;
/** Long-press duration (ms) that opens the context menu on touch — BUILD-SPEC "Long-press (~500ms) on touch = same menu." */
const LONG_PRESS_MS = 500;

interface Props {
  projectId: string;
  initialPhases: SchedulePhaseWithVisits[];
  /**
   * Board cockpit round — "timeline tick markers for task due/booking
   * dates" + milestone diamonds. Optional/defaults to [] so this prop
   * is additive — every existing caller of GanttChart (there is
   * currently only app/(dashboard)/projects/[id]/timeline/page.tsx,
   * updated in this same round to pass it) keeps compiling even if a
   * future caller omits it. Read-only rendering data; see PhaseRow's
   * marker rendering below for the render approach (an absolutely-
   * positioned, pointer-events-none layer, same pattern as the
   * existing today-line marker — see this file's own "Today line" doc
   * comment) — this never touches lib/phase-drag.ts or the drag
   * pointer handlers in PhaseRow/UmbrellaBand.
   */
  timelineMarkers?: GanttTimelineMarker[];
}

const COLOR_KEYS: PhaseColorKey[] = ["sand", "charcoal", "teal", "amber"];
const WIDE_GRID_THRESHOLD = 12; // weeks — kept for reference (see showZoomToggle's doc comment); no longer gates the toggle's visibility as of this round.

/** Board cockpit round — Day zoom's decorative day-of-week header initials, Monday-first to match lib/gantt.ts's own Monday-aligned week grid (startOfWeek()). */
const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * localStorage key for this round's per-project visit-row expansion
 * memory (BUILD-SPEC.md "Internal timeline — trade visit sub-bars":
 * "Expansion state remembered per project (localStorage)"). Scoped by
 * projectId so two different projects' expand states never collide in
 * the same browser — see loadVisitExpansion/saveVisitExpansion below.
 * A plain client-only preference, never sent to the server (same tier
 * as e.g. the zoom toggle, which is also NOT persisted across
 * sessions — expansion goes one step further and IS persisted, per the
 * brief's explicit ask, but through localStorage only, never a
 * database write).
 */
function visitExpansionStorageKey(projectId: string): string {
  return `reslu:gantt:visit-expansion:${projectId}`;
}

function loadVisitExpansion(projectId: string): VisitExpansionState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(visitExpansionStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as VisitExpansionState) : {};
  } catch {
    return {}; // corrupt/blocked storage — fall back to "nothing expanded", never throw
  }
}

function saveVisitExpansion(projectId: string, state: VisitExpansionState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(visitExpansionStorageKey(projectId), JSON.stringify(state));
  } catch {
    // Storage full/blocked (private browsing etc.) — expansion just
    // won't persist this session; never breaks the timeline itself.
  }
}

/**
 * Bar fill colours — brand-muted per BUILD-SPEC.md ("brand-muted bar
 * colours"). sand/charcoal are the actual brand palette; teal/amber
 * are additional accent tones for Gantt differentiation (migration
 * 013's color_key check constraint comment) — kept muted/desaturated
 * so they read as brand-adjacent rather than introducing loud new
 * brand colours.
 */
const COLOR_SWATCH: Record<PhaseColorKey, string> = {
  sand: "#A08C72",
  charcoal: "#313131",
  teal: "#5F8A82",
  amber: "#B98A4A",
};

/**
 * Gantt (Timeline tab) — BUILD-SPEC.md "Gantt": CSS-grid table, left
 * column phase names, columns = weeks spanning min(start) to max(end)
 * (capped 52, month labels header), bars positioned by grid-column
 * start/span, inline edit panel per phase, add-phase form. See
 * lib/gantt.ts for the week-grid math shared by this component.
 *
 * Timeline v2 additions (Phase 11A): trade-visit overview dots per
 * phase row (full detail in the edit panel), an auto-maintained
 * umbrella band ("Site Setup"), a week/month zoom toggle for wide
 * grids, a collapsible "Completed" group, a today-line marker, a
 * sticky phase-name column for mobile horizontal scroll, and a mobile
 * bottom sheet for tapping a visit dot.
 */
export function GanttChart({ projectId, initialPhases, timelineMarkers = [] }: Props) {
  const [phases, setPhases] = useState<SchedulePhaseWithVisits[]>(initialPhases);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Round A "Add phase starting this week" (right-click empty timeline
  // space) — prefills the existing AddPhaseForm's start date rather than
  // inventing a second add-phase entry point. Cleared whenever the form
  // closes/submits so a later plain "+ Add phase" click doesn't carry a
  // stale prefill over.
  const [addPrefillStart, setAddPrefillStart] = useState<string | null>(null);
  // Board cockpit round — extended to a third "day" level (was
  // week/month only, Round A). "week" stays the fixed default per this
  // round's brief ("Week is the current default/fixed mode — keep it
  // as the simplest baseline"); "day" is purely a wider rendering of
  // the SAME week-column grid (see colMinWidth below) plus day-grain
  // gridlines/labels in the header — it does not introduce a second
  // coordinate system, so drag/resize math (columnPx measured from the
  // actual rendered grid at drag-start, see startDrag below) keeps
  // working unmodified at every zoom level: widening columns only
  // changes what that measurement returns, never the formula itself.
  const [zoom, setZoom] = useState<"day" | "week" | "month">("week");
  const [sheetVisit, setSheetVisit] = useState<TradeVisitWithContact | null>(null);
  // Round A right-click context menu state — see components/shared/ContextMenu.tsx.
  const [menu, setMenu] = useState<{
    position: { x: number; y: number };
    phase: SchedulePhaseWithVisits | null; // null = empty row/timeline space
    weekStart?: string; // ISO date — the week column right-clicked, for "Add phase starting this week"
  } | null>(null);
  // Round A "Book trade" context-menu action — prefills the phase's own
  // edit panel with the Visits panel's add-visit mini-form already open
  // (reuses the existing AddVisitForm inside VisitsPanel rather than a
  // new booking UI), instead of only expanding the phase row.
  const [bookTradePhaseId, setBookTradePhaseId] = useState<string | null>(null);
  // Round A drag state — which phase (by id) is currently being
  // dragged/resized, its mode, and a live day-delta preview so the bar
  // can render its dragged position before the PATCH round-trip
  // resolves (BUILD-SPEC "visual feedback while dragging").
  const [dragState, setDragState] = useState<{
    phaseId: string;
    mode: DragMode;
    deltaDays: number;
  } | null>(null);
  // Internal timeline — trade visit sub-bars (BUILD-SPEC.md): per-phase
  // expand/collapse, seeded from localStorage on mount (client-only —
  // starts empty on the server render, then hydrates once in the effect
  // below; harmless one-frame flash of "collapsed" on first paint,
  // same tradeoff every localStorage-backed UI preference in this app
  // already accepts, e.g. no existing precedent stores this kind of
  // pure-UI state any differently).
  const [expanded, setExpanded] = useState<VisitExpansionState>({});
  useEffect(() => {
    setExpanded(loadVisitExpansion(projectId));
  }, [projectId]);
  function toggleExpanded(phaseId: string) {
    setExpanded((cur) => {
      const next = { ...cur, [phaseId]: !cur[phaseId] };
      saveVisitExpansion(projectId, next);
      return next;
    });
  }
  // Visit sub-bar drag state — mirrors dragState above exactly (same
  // shape, one level down: phaseId -> visitId), kept as a SEPARATE
  // piece of state rather than folded into dragState since a visit
  // drag and a phase drag are mutually exclusive gestures but need
  // independent "which row is this" keys (a visitId is never a
  // phaseId) — reusing one field would need a discriminant anyway, so
  // two fields is simpler and keeps PhaseRow's existing dragState
  // wiring completely untouched.
  const [visitDragState, setVisitDragState] = useState<{
    visitId: string;
    mode: DragMode;
    deltaDays: number;
    /** Captured at drag-START (BUILD-SPEC: "if the visit was status 'confirmed'" — the ORIGINAL status, before this drag's own PATCH potentially changes it via the reconfirm flow's own status reset) — decides whether commitVisitDrag shows the reconfirm affordance afterwards. */
    wasConfirmed: boolean;
  } | null>(null);
  // "Dates changed — re-send confirmation?" — which visit ids currently
  // show the affordance (a Set, not a single id, since more than one
  // confirmed visit could be dragged in the same session before either
  // is dismissed/resent).
  const [reconfirmPrompts, setReconfirmPrompts] = useState<Set<string>>(new Set());
  function dismissReconfirm(visitId: string) {
    setReconfirmPrompts((cur) => {
      const next = new Set(cur);
      next.delete(visitId);
      return next;
    });
  }
  const gridBodyRef = useRef<HTMLDivElement>(null);

  const umbrella = phases.find((p) => p.kind === "umbrella") ?? null;
  const ordinaryPhases = useMemo(() => phases.filter((p) => p.kind === "phase"), [phases]);

  // Board cockpit round — group timeline markers by phase_id so each
  // PhaseRow only renders the markers belonging to it. Purely a lookup
  // built from the read-only `timelineMarkers` prop; touches no drag
  // state.
  const markersByPhase = useMemo(() => {
    const map = new Map<string, GanttTimelineMarker[]>();
    for (const m of timelineMarkers) {
      if (!m.phase_id) continue;
      const list = map.get(m.phase_id) ?? [];
      list.push(m);
      map.set(m.phase_id, list);
    }
    return map;
  }, [timelineMarkers]);

  const grid = useMemo(
    () => computeGanttGrid(ordinaryPhases.length > 0 ? ordinaryPhases : phases),
    [ordinaryPhases, phases]
  );

  const todayPos = useMemo(() => todayGridPosition(grid), [grid]);
  // Board cockpit round — the zoom toggle is now ALWAYS shown (Day
  // view is useful on any job length, not just >12-week ones); the
  // >12-week threshold still exists as WIDE_GRID_THRESHOLD but no
  // longer gates visibility, only kept as an exported constant in case
  // a future "auto-suggest month zoom" nudge wants it (none exists
  // today — this round's brief is explicit that zoom must be an
  // explicit toggle, not auto-detection).
  const showZoomToggle = true;
  // Day/Week/Month zoom (BUILD-SPEC "week/month zoom toggle for
  // >12-week grids", extended this round to a third Day level):
  // rather than re-deriving a whole separate day- or month-column grid
  // (which would need its own math in lib/gantt.ts and its own
  // bar-position formula), every zoom level reuses the EXACT SAME
  // week grid and instead only widens/narrows each week column's
  // minmax floor — "month" squeezes columns so more weeks fit without
  // scrolling, "day" widens columns enough that individual days become
  // visually distinguishable (with day-grain gridlines/labels added in
  // the header, see the week-header map below) and horizontal scroll
  // becomes the expected interaction (the grid wrapper below already
  // has overflow-x-auto at every zoom level — this is the one place in
  // the app horizontal scroll is expected/sanctioned, matching a
  // Gantt/Timeline's normal interaction model). A defensible, low-risk
  // way to get three "zoom" feels within lib/gantt.ts's existing week-
  // grid math without a rewrite or a second coordinate system.
  const colMinWidth = zoom === "month" ? "10px" : zoom === "day" ? "140px" : "28px";

  const today = new Date().toISOString().slice(0, 10);
  const completedPhases = useMemo(
    () => ordinaryPhases.filter((p) => p.end_date < today),
    [ordinaryPhases, today]
  );
  const activePhases = useMemo(
    () => ordinaryPhases.filter((p) => p.end_date >= today),
    [ordinaryPhases, today]
  );

  async function addPhase(input: {
    name: string;
    start_date: string;
    end_date: string;
    color_key: PhaseColorKey;
  }) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/phases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add phase.");
      const { phase } = await res.json();
      setPhases((cur) => [...cur, { ...phase, contact: null, visits: [] }]);
      setAdding(false);
      setAddPrefillStart(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add phase.");
    }
  }

  async function patchPhase(
    phase: SchedulePhaseWithVisits,
    patch: Record<string, unknown>,
    refUpdate?: Partial<SchedulePhaseWithVisits>
  ) {
    const prev = phases;
    setPhases((cur) =>
      cur.map((p) => (p.id === phase.id ? { ...p, ...patch, ...refUpdate } : p))
    );
    setError(null);
    try {
      const res = await fetch(`/api/phases/${phase.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update phase.");
      const { phase: updated } = await res.json();
      setPhases((cur) => cur.map((p) => (p.id === phase.id ? { ...p, ...updated } : p)));
    } catch (err) {
      setPhases(prev);
      setError(err instanceof Error ? err.message : "Could not update phase.");
    }
  }

  /**
   * Round A context-menu "Shift −1 week / Shift +1 week" — an
   * immediate PATCH (no intermediate edit-panel step), reusing
   * patchPhase's exact same optimistic-update/revert-on-failure path.
   * Both dates shift equally, same as a drag "move".
   */
  function shiftPhaseWeek(phase: SchedulePhaseWithVisits, weeks: 1 | -1) {
    const result = applyDrag(phase, "move", weeks * 7);
    patchPhase(phase, { start_date: result.start_date, end_date: result.end_date });
  }

  /**
   * Round A "Timeline slider bars" drag commit — called on pointerup
   * once a drag/resize gesture has accumulated a non-zero day delta.
   * Reuses patchPhase's optimistic-update/revert-on-failure path so a
   * failed PATCH snaps the bar back exactly like any other edit.
   */
  function commitDrag(phase: SchedulePhaseWithVisits, mode: DragMode, deltaDays: number) {
    if (deltaDays === 0) return;
    const result = applyDrag(phase, mode, deltaDays);
    if (result.start_date === phase.start_date && result.end_date === phase.end_date) return;
    patchPhase(phase, { start_date: result.start_date, end_date: result.end_date });
  }

  async function deletePhase(phase: SchedulePhaseWithVisits) {
    if (!confirm(`Remove phase "${phase.name}"?`)) return;
    const prev = phases;
    setPhases((cur) => cur.filter((p) => p.id !== phase.id));
    setEditingId(null);
    const res = await fetch(`/api/phases/${phase.id}`, { method: "DELETE" });
    if (!res.ok) {
      setPhases(prev);
      setError("Could not remove phase.");
    }
  }

  function replaceVisit(phaseId: string, visit: TradeVisitWithContact) {
    setPhases((cur) =>
      cur.map((p) =>
        p.id === phaseId ? { ...p, visits: p.visits.map((v) => (v.id === visit.id ? visit : v)) } : p
      )
    );
  }

  function addVisitToPhase(phaseId: string, visit: TradeVisitWithContact) {
    setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, visits: [...p.visits, visit] } : p)));
  }

  function removeVisitFromPhase(phaseId: string, visitId: string) {
    setPhases((cur) =>
      cur.map((p) => (p.id === phaseId ? { ...p, visits: p.visits.filter((v) => v.id !== visitId) } : p))
    );
  }

  /**
   * Internal timeline — trade visit sub-bars: PATCH a single visit's
   * dates, optimistic (mirrors patchPhase's exact optimistic-update/
   * revert-on-failure shape) — updates the visit in place inside its
   * parent phase's `visits` array via replaceVisit, reverting the whole
   * `phases` array on a failed request.
   */
  async function patchVisit(visit: TradeVisitWithContact, patch: Record<string, unknown>) {
    const prev = phases;
    replaceVisit(visit.phase_id, { ...visit, ...patch } as TradeVisitWithContact);
    setError(null);
    try {
      const res = await fetch(`/api/visits/${visit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update visit.");
      const { visit: updated } = await res.json();
      replaceVisit(visit.phase_id, updated);
      return updated as TradeVisitWithContact;
    } catch (err) {
      setPhases(prev);
      setError(err instanceof Error ? err.message : "Could not update visit.");
      return null;
    }
  }

  /**
   * Visit sub-bar drag commit — mirrors commitDrag (phase bars) exactly,
   * one level down: same applyDrag/no-op-on-zero-delta shape, using
   * patchVisit instead of patchPhase. After a successful, actually-
   * changed PATCH, if the visit's status WAS 'confirmed' at drag-start
   * (captured in visitDragState.wasConfirmed, since patchVisit's own
   * response reflects the NEW row, not what it was before this drag),
   * surface the "Dates changed — re-send confirmation?" affordance —
   * BUILD-SPEC.md: "re-confirmation NOT auto-triggered on drag ... show
   * [the] affordance instead, since silently moving a confirmed trade's
   * dates without re-confirming is how no-shows happen." The affordance
   * itself never fires an email on its own — only the explicit
   * "Re-send" button inside it does (see ReconfirmAffordance.tsx +
   * POST /api/visits/[id]/resend-confirmation).
   */
  async function commitVisitDrag(
    visit: TradeVisitWithContact,
    mode: DragMode,
    deltaDays: number,
    wasConfirmed: boolean
  ) {
    if (deltaDays === 0) return;
    const result = applyDrag(visit, mode, deltaDays);
    if (result.start_date === visit.start_date && result.end_date === visit.end_date) return;
    const updated = await patchVisit(visit, { start_date: result.start_date, end_date: result.end_date });
    if (updated && wasConfirmed) {
      setReconfirmPrompts((cur) => new Set(cur).add(visit.id));
    }
  }

  /**
   * Visit sub-bar drag lifecycle — byte-for-byte the same pattern as
   * startDrag (phase bars) below: one pointermove/pointerup pair
   * attached to `document` for the gesture's duration, columnPx
   * measured once at drag-start from the SAME gridBodyRef (visits
   * render inside the identical week-grid width phase bars do, so this
   * measurement is valid for both without any adjustment). Deliberately
   * NOT wrapped in useCallback for the identical reason startDrag isn't
   * (see that function's own doc comment) — commitVisitDrag closes over
   * the current render's `phases` via patchVisit's optimistic-update
   * path.
   */
  function startVisitDrag(visit: TradeVisitWithContact, mode: DragMode, startClientX: number) {
    const body = gridBodyRef.current;
    if (!body) return;
    const nameColumnPx = 200;
    const bodyWidth = body.getBoundingClientRect().width - nameColumnPx;
    const columnPx = bodyWidth / grid.weekCount;
    const wasConfirmed = visit.status === "confirmed";

    setVisitDragState({ visitId: visit.id, mode, deltaDays: 0, wasConfirmed });

    function onMove(e: PointerEvent) {
      const deltaPx = e.clientX - startClientX;
      const deltaDays = snapDeltaDays(deltaPx, columnPx);
      setVisitDragState({ visitId: visit.id, mode, deltaDays, wasConfirmed });
    }
    function onUp(e: PointerEvent) {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const deltaPx = e.clientX - startClientX;
      const deltaDays = snapDeltaDays(deltaPx, columnPx);
      setVisitDragState(null);
      commitVisitDrag(visit, mode, deltaDays, wasConfirmed);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  async function resendConfirmation(visitId: string): Promise<void> {
    const res = await fetch(`/api/visits/${visitId}/resend-confirmation`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error ?? "Could not re-send confirmation.");
    const { visit } = await res.json();
    replaceVisit(visit.phase_id, visit);
  }

  // Round A drag lifecycle — a single pointer-move/pointer-up listener
  // pair attached to `document` for the duration of one drag gesture
  // (attached in startDrag, torn down on pointerup), rather than one
  // listener per bar, so a fast drag that outruns the bar's own
  // boundaries (pointer leaves the row while dragging) keeps tracking
  // correctly. `columnPx` is measured ONCE at drag-start from the
  // actual rendered grid (gridBodyRef), per lib/phase-drag.ts's own
  // "zero DOM access, caller measures" contract — this keeps the drag
  // math byte-for-byte consistent with lib/gantt.ts's
  // `(100% / weekCount)` column-width formula, since both this
  // measurement and that CSS calc() divide the exact same grid body
  // width by the exact same weekCount.
  //
  // Deliberately NOT wrapped in useCallback: commitDrag (called from
  // onUp) closes over patchPhase, which closes over the CURRENT
  // render's `phases` state (its optimistic-update/revert-on-failure
  // path reads `phases` directly, not via a ref) — a memoised
  // startDrag would freeze that closure at whatever render created it,
  // so a second drag started without an intervening re-render of this
  // exact function could revert to a stale `phases` snapshot on
  // failure. Recreating this function every render (cheap: it only
  // attaches listeners inside an actual drag gesture, never on
  // render itself) keeps it always closing over the latest state.
  function startDrag(phase: SchedulePhaseWithVisits, mode: DragMode, startClientX: number) {
    const body = gridBodyRef.current;
    if (!body) return;
    const nameColumnPx = 200;
    const bodyWidth = body.getBoundingClientRect().width - nameColumnPx;
    const columnPx = bodyWidth / grid.weekCount;

    setDragState({ phaseId: phase.id, mode, deltaDays: 0 });

    function onMove(e: PointerEvent) {
      const deltaPx = e.clientX - startClientX;
      const deltaDays = snapDeltaDays(deltaPx, columnPx);
      setDragState({ phaseId: phase.id, mode, deltaDays });
    }
    function onUp(e: PointerEvent) {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const deltaPx = e.clientX - startClientX;
      const deltaDays = snapDeltaDays(deltaPx, columnPx);
      setDragState(null);
      commitDrag(phase, mode, deltaDays);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function openPhaseMenu(phase: SchedulePhaseWithVisits, position: { x: number; y: number }) {
    setMenu({ position, phase });
  }

  function openEmptyMenu(position: { x: number; y: number }, weekStart?: string) {
    setMenu({ position, phase: null, weekStart });
  }

  function renderPhaseRow(phase: SchedulePhaseWithVisits) {
    const pos = phaseGridPosition(phase, grid);
    const drag = dragState && dragState.phaseId === phase.id ? dragState : null;
    // Internal timeline — trade visit sub-bars: auto-expanded at Day
    // zoom (BUILD-SPEC "auto-expanded at Day zoom"), otherwise the
    // persisted per-project localStorage state (defaults to collapsed
    // — `expanded[phase.id]` is undefined, falsy, for a phase never
    // toggled before).
    const isExpanded = zoom === "day" || !!expanded[phase.id];
    return (
      <PhaseRow
        key={phase.id}
        projectId={projectId}
        phase={phase}
        gridPos={pos}
        weekCount={grid.weekCount}
        editing={editingId === phase.id}
        onToggleEdit={() => setEditingId((cur) => (cur === phase.id ? null : phase.id))}
        onPatch={(patch, refUpdate) => patchPhase(phase, patch, refUpdate)}
        onDelete={() => deletePhase(phase)}
        onTapVisit={setSheetVisit}
        onAddVisit={(v) => addVisitToPhase(phase.id, v)}
        onPatchVisit={(v) => replaceVisit(phase.id, v)}
        onDeleteVisit={(id) => removeVisitFromPhase(phase.id, id)}
        dragMode={drag?.mode ?? null}
        dragDeltaDays={drag?.deltaDays ?? 0}
        onStartDrag={(mode, clientX) => startDrag(phase, mode, clientX)}
        onContextMenu={(position) => openPhaseMenu(phase, position)}
        forceOpenAddVisit={bookTradePhaseId === phase.id}
        onAddVisitOpened={() => setBookTradePhaseId(null)}
        markers={markersByPhase.get(phase.id) ?? []}
        grid={grid}
        zoom={zoom}
        isExpanded={isExpanded}
        onToggleExpanded={zoom === "day" ? undefined : () => toggleExpanded(phase.id)}
        visitDragState={visitDragState}
        onStartVisitDrag={startVisitDrag}
        reconfirmPrompts={reconfirmPrompts}
        onResendConfirmation={resendConfirmation}
        onDismissReconfirm={dismissReconfirm}
      />
    );
  }

  // Round A "Change colour" submenu items — reused by both the phase
  // and umbrella context-menu wiring below (umbrella bars are
  // draggable/right-clickable too per BUILD-SPEC "umbrella bars
  // draggable too").
  function colorSubmenu(phase: SchedulePhaseWithVisits): ContextMenuItem[] {
    return COLOR_KEYS.map((key) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      swatch: COLOR_SWATCH[key],
      onSelect: () => patchPhase(phase, { color_key: key }),
    }));
  }

  const menuItems: ContextMenuItem[] = menu?.phase
    ? (() => {
        const phase = menu.phase;
        return [
          { key: "edit", label: "Edit dates", onSelect: () => setEditingId(phase.id) },
          { key: "shift-back", label: "Shift −1 week", onSelect: () => shiftPhaseWeek(phase, -1) },
          { key: "shift-fwd", label: "Shift +1 week", onSelect: () => shiftPhaseWeek(phase, 1) },
          {
            key: "book-trade",
            label: "Book trade",
            onSelect: () => {
              setEditingId(phase.id);
              setBookTradePhaseId(phase.id);
            },
          },
          { key: "colour", label: "Change colour", items: colorSubmenu(phase) },
          // "Mark complete" — SKIPPED per this round's brief:
          // schedule_phases has no complete/status column (a phase's
          // only date-shaped state is start_date/end_date; "done" is
          // inferred client-side from end_date < today, see
          // completedPhases above, not stored). Adding one would need a
          // migration, which is out of this round's "no new migration"
          // boundary — documented here rather than silently omitted.
        ];
      })()
    : [
        {
          key: "add-phase",
          label: "Add phase starting this week",
          onSelect: () => {
            setAddPrefillStart(menu?.weekStart ?? grid.weeks[0]?.toISOString().slice(0, 10) ?? null);
            setAdding(true);
          },
        },
      ];

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {showZoomToggle && (
        <div className="flex items-center gap-2">
          <span className="label-caps">Zoom</span>
          <button
            type="button"
            onClick={() => setZoom("day")}
            title="Day view — wider columns, horizontal scroll, day-grain gridlines"
            className={clsx(
              "border px-3 py-1 text-caption",
              zoom === "day" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal"
            )}
          >
            Day
          </button>
          <button
            type="button"
            onClick={() => setZoom("week")}
            className={clsx(
              "border px-3 py-1 text-caption",
              zoom === "week" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal"
            )}
          >
            Week
          </button>
          <button
            type="button"
            onClick={() => setZoom("month")}
            className={clsx(
              "border px-3 py-1 text-caption",
              zoom === "month" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal"
            )}
          >
            Month
          </button>
        </div>
      )}

      {phases.length === 0 ? (
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">No phases yet. Add the first one to start the timeline.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-[#dcd6cc]">
          <div
            ref={gridBodyRef}
            className="relative grid"
            style={{ gridTemplateColumns: `200px repeat(${grid.weekCount}, minmax(${colMinWidth}, 1fr))` }}
          >
            {/* Today line — an absolutely-positioned vertical marker
                spanning every row, computed via the same week-grid math
                used for phase bars. */}
            {todayPos && (
              <div
                className="pointer-events-none absolute inset-y-0 z-10 w-px bg-sand"
                style={{
                  left: `calc(200px + ((100% - 200px) / ${grid.weekCount}) * ${todayPos.startCol - 1})`,
                }}
                title="Today"
              />
            )}

            {/* Header row: sticky phase-name column header + month labels spanning weeks */}
            <div className="sticky left-0 z-20 border-b border-r border-[#dcd6cc] bg-cream px-3 py-2">
              <span className="label-caps">Phase</span>
            </div>
            {grid.weeks.map((week, i) => (
              <div
                key={i}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openEmptyMenu({ x: e.clientX, y: e.clientY }, week.toISOString().slice(0, 10));
                }}
                className="border-b border-[#e5e0d6] bg-cream px-1 py-2 text-center"
              >
                {isNewMonth(grid.weeks, i) && (
                  <span className="label-caps whitespace-nowrap">{monthLabel(week)}</span>
                )}
                {/* Board cockpit round — Day zoom's day-grain gridlines/
                    labels: purely decorative, header-row-only (never
                    touches the bar row below, so it cannot interfere
                    with drag/resize) — seven day-of-week initials
                    spanning this SAME week column, giving the "day"
                    feel without a second grid/coordinate system. Only
                    rendered when zoom === 'day' — week/month zoom keep
                    the exact unchanged header they had before this
                    round. */}
                {zoom === "day" && (
                  <div className="mt-1 grid grid-cols-7 gap-px">
                    {DAY_INITIALS.map((d, dayIdx) => (
                      <span key={dayIdx} className="text-caption text-charcoal/30">
                        {d}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Umbrella band ("Site Setup") — always renders first if present.
                Fix Round A: dates are now editable like any normal phase
                (onPatch below reuses the exact same patchPhase() helper
                every ordinary PhaseRow uses) — see UmbrellaBand.tsx's own
                doc comment for the span-fix rationale. */}
            {umbrella && (
              <UmbrellaBand
                name={umbrella.name}
                startDate={umbrella.start_date}
                endDate={umbrella.end_date}
                grid={grid}
                costSectionLines={umbrella.cost_section_lines ?? []}
                onPatch={(patch) => patchPhase(umbrella, patch)}
                dragMode={dragState && dragState.phaseId === umbrella.id ? dragState.mode : null}
                dragDeltaDays={dragState && dragState.phaseId === umbrella.id ? dragState.deltaDays : 0}
                onStartDrag={(mode, clientX) => startDrag(umbrella, mode, clientX)}
                onContextMenu={(position) => openPhaseMenu(umbrella, position)}
              />
            )}

            {/* Active (not-yet-completed) phases render directly */}
            {activePhases.map(renderPhaseRow)}

            {/* Completed phases collapse into one group, expandable */}
            <CompletedPhasesGroup phases={completedPhases} weekCount={grid.weekCount} renderRow={renderPhaseRow} />
          </div>
        </div>
      )}

      {adding ? (
        <AddPhaseForm
          initialStart={addPrefillStart}
          onAdd={addPhase}
          onCancel={() => {
            setAdding(false);
            setAddPrefillStart(null);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
        >
          + Add phase
        </button>
      )}

      {sheetVisit && (
        <VisitBottomSheet
          visit={sheetVisit}
          onClose={() => setSheetVisit(null)}
          onConfirmed={(updated) => {
            replaceVisit(updated.phase_id, updated);
            setSheetVisit(updated);
          }}
        />
      )}

      {menu && <ContextMenu position={menu.position} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

function PhaseRow({
  projectId,
  phase,
  gridPos,
  weekCount,
  editing,
  onToggleEdit,
  onPatch,
  onDelete,
  onTapVisit,
  onAddVisit,
  onPatchVisit,
  onDeleteVisit,
  dragMode,
  dragDeltaDays,
  onStartDrag,
  onContextMenu,
  forceOpenAddVisit,
  onAddVisitOpened,
  markers,
  grid,
  zoom,
  isExpanded,
  onToggleExpanded,
  visitDragState,
  onStartVisitDrag,
  reconfirmPrompts,
  onResendConfirmation,
  onDismissReconfirm,
}: {
  /** Board cockpit round — needed to build the timeline marker click-through link (?focus=board_task-<id> on the Board tab). */
  projectId: string;
  phase: SchedulePhaseWithVisits;
  gridPos: { startCol: number; span: number };
  weekCount: number;
  editing: boolean;
  onToggleEdit: () => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<SchedulePhaseWithVisits>) => void;
  onDelete: () => void;
  onTapVisit: (visit: TradeVisitWithContact) => void;
  onAddVisit: (visit: TradeVisitWithContact) => void;
  onPatchVisit: (visit: TradeVisitWithContact) => void;
  onDeleteVisit: (visitId: string) => void;
  /** Round A drag preview state — null dragMode means this row isn't the one being dragged. */
  dragMode: DragMode | null;
  dragDeltaDays: number;
  onStartDrag: (mode: DragMode, clientX: number) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  /** Round A "Book trade" context-menu action — see VisitsPanel's own forceOpen handling below. */
  forceOpenAddVisit: boolean;
  onAddVisitOpened: () => void;
  /** Board cockpit round — this phase's own timeline markers (due_date/booking_date/milestone), already filtered by GanttChart's markersByPhase map. */
  markers: GanttTimelineMarker[];
  /** Board cockpit round — the shared week grid (lib/gantt.ts's GanttGrid), needed to position markers via phaseGridPosition. weekCount alone (the pre-existing prop) isn't enough since phaseGridPosition also needs gridStart/weeks. */
  grid: GanttGrid;
  /** Internal timeline — trade visit sub-bars (this round). Current zoom level — Day zoom shows the label on-bar and forces every row expanded (see isExpanded/onToggleExpanded below). */
  zoom: "day" | "week" | "month";
  /** Whether this phase's sub-bar row is currently shown — true at Day zoom regardless of the persisted preference (GanttChart.tsx's renderPhaseRow computes this), or the persisted per-project localStorage value otherwise. */
  isExpanded: boolean;
  /** undefined at Day zoom (the chevron is hidden — there is nothing to toggle since every row is force-expanded there); a callback otherwise. */
  onToggleExpanded: (() => void) | undefined;
  visitDragState: { visitId: string; mode: DragMode; deltaDays: number; wasConfirmed: boolean } | null;
  onStartVisitDrag: (visit: TradeVisitWithContact, mode: DragMode, clientX: number) => void;
  reconfirmPrompts: Set<string>;
  onResendConfirmation: (visitId: string) => Promise<void>;
  onDismissReconfirm: (visitId: string) => void;
}) {
  const dragging = dragMode !== null;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  /**
   * Pointer-down on the bar body — BUILD-SPEC "grab bar body = move
   * whole phase, grab 6px edge zones = resize start or end". Mouse only
   * (see the EDGE_ZONE_PX-based mode below); touch deliberately does
   * NOT start a drag here (BUILD-SPEC "Touch: do NOT attempt edge-drag
   * ... tap opens the existing edit panel"), it only starts the
   * long-press-to-menu timer via onTouchStart below.
   */
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const mode: DragMode =
      offsetX <= EDGE_ZONE_PX ? "resize-start" : offsetX >= rect.width - EDGE_ZONE_PX ? "resize-end" : "move";
    onStartDrag(mode, e.clientX);
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    const touch = e.touches[0];
    if (!touch) return;
    const x = touch.clientX;
    const y = touch.clientY;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      onContextMenu({ x, y });
    }, LONG_PRESS_MS);
  }

  return (
    <>
      <div className="sticky left-0 z-10 col-start-1 border-b border-r border-[#e5e0d6] bg-nearwhite px-3 py-2">
        <div className="flex items-center gap-1">
          {/* Internal timeline — trade visit sub-bars: expand/collapse
              chevron, only shown when there's something to expand
              (BUILD-SPEC "expandable phase rows (chevron; auto-expanded
              at Day zoom; expansion remembered per project in
              localStorage)") and only interactive when
              onToggleExpanded is defined — undefined at Day zoom, where
              every row is already force-expanded (see PhaseRow's own
              doc comment on that prop), so the chevron is shown but
              inert there rather than hidden outright (keeps the row's
              layout stable across zoom changes instead of the label
              jumping left/right). */}
          {phase.visits.length > 0 && (
            <button
              type="button"
              onClick={onToggleExpanded}
              disabled={!onToggleExpanded}
              aria-label={isExpanded ? "Collapse trade visits" : "Expand trade visits"}
              aria-expanded={isExpanded}
              className={clsx(
                "shrink-0 text-charcoal/50 transition-transform",
                isExpanded && "rotate-90",
                onToggleExpanded ? "hover:text-nearblack" : "cursor-default opacity-50"
              )}
            >
              ▸
            </button>
          )}
          <button
            type="button"
            onClick={onToggleEdit}
            className="text-left text-body text-nearblack hover:text-sand"
          >
            {phase.name}
          </button>
        </div>
        <p className="text-caption text-charcoal/40">
          {phase.start_date} → {phase.end_date}
        </p>
        {phase.visits.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {phase.visits.slice(0, 6).map((v) => (
              <VisitBar
                key={v.id}
                companyLabel={v.contact?.company ?? "Trade"}
                status={v.status}
                onTap={() => onTapVisit(v)}
              />
            ))}
            {phase.visits.length > 6 && (
              <span className="text-caption text-charcoal/40">+{phase.visits.length - 6}</span>
            )}
          </div>
        )}
      </div>
      <div
        className="relative border-b border-[#e5e0d6] py-2"
        style={{ gridColumn: `2 / span ${weekCount}` }}
      >
        <div
          onPointerDown={handlePointerDown}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu({ x: e.clientX, y: e.clientY });
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={clearLongPress}
          onTouchMove={clearLongPress}
          onTouchCancel={clearLongPress}
          className={clsx(
            "h-4 cursor-grab transition-opacity",
            dragging && "cursor-grabbing opacity-60 outline outline-2 outline-nearblack"
          )}
          style={{
            marginLeft: `calc((100% / ${weekCount}) * ${gridPos.startCol - 1 + (dragMode === "move" || dragMode === "resize-start" ? dragDeltaDays / 7 : 0)})`,
            width: `calc((100% / ${weekCount}) * ${gridPos.span + (dragMode === "resize-start" ? -dragDeltaDays / 7 : dragMode === "resize-end" ? dragDeltaDays / 7 : 0)})`,
            backgroundColor: COLOR_SWATCH[phase.color_key],
          }}
          title={`${phase.name}: ${phase.start_date} to ${phase.end_date}`}
        />

        {/* Board cockpit round — timeline tick markers (due_date/
            booking_date/milestone diamonds). Absolutely positioned,
            pointer-events-none WRAPPER (see markerWrapperClass below —
            the wrapper itself never intercepts pointer events; only the
            small clickable tick/diamond inside re-enables them), computed
            from the SAME grid math as the phase bar above
            (phaseGridPosition on a synthetic single-day range) but
            rendered as an independent sibling layer — this never reads
            dragMode/dragDeltaDays and has no drag pointer handlers of
            its own, so it cannot intercept or shift the bar's own drag
            gestures (mirrors this file's existing today-line marker,
            which uses the identical "absolute + pointer-events-none +
            calc() from grid math" approach one level up at the
            whole-grid scope; this is the same technique at the
            single-row scope).
            Sizing: due/booking ticks are 3px wide (BUILD-SPEC "sand
            ticks (3px)"); booking ticks render TALLER (h-5) and in the
            full-strength brand sand, due ticks render SHORTER (h-3) and
            in a duller charcoal tone, so the two read as visually
            distinct without needing a legend. Milestone diamonds are
            unaffected (their own shape already differentiates them).
            Click navigates to the Board, focused on the source card —
            same ?focus=board_task-<id> + FocusOnLoad mechanism the My
            Work feed's board_task links already use (see
            app/api/my-work/route.ts source #1's href and
            components/shared/FocusOnLoad.tsx) — this is a plain <a>,
            not a client-side-only onClick, so it works with a normal
            navigation (new tab / cmd-click) too. */}
        {markers.map((marker) => {
          const markerPos = phaseGridPosition({ start_date: marker.date, end_date: marker.date }, grid);
          const label = `${marker.kind === "milestone" ? "Milestone" : marker.kind === "booking_date" ? "Booking" : "Due"}: ${marker.title} (${marker.date})`;
          return (
            <a
              key={`${marker.kind}-${marker.task_id}`}
              href={`/projects/${projectId}/board?focus=board_task-${marker.task_id}`}
              title={label}
              aria-label={label}
              className="absolute top-0 flex h-5 items-start justify-center pointer-events-auto"
              style={{ left: `calc((100% / ${weekCount}) * ${markerPos.startCol - 1})` }}
            >
              {marker.kind === "milestone" ? (
                <span className="block h-2.5 w-2.5 rotate-45 border border-sand bg-sand" />
              ) : marker.kind === "booking_date" ? (
                <span className="block h-5 w-[3px] bg-sand" />
              ) : (
                <span className="mt-1 block h-3 w-[3px] bg-charcoal/50" />
              )}
            </a>
          );
        })}
      </div>

      {/* Internal timeline — trade visit sub-bars (BUILD-SPEC.md
          "Internal timeline — trade visit sub-bars"): one thin sub-row
          per visit, shown when this phase row is expanded. A separate
          grid row (col 1 = a blank sticky spacer matching the name
          column's own sticky/border treatment so the row reads as
          "part of" the phase above it, col 2 = spans the same
          `2 / span weekCount` the phase's own bar row uses) — NOT a
          second bar layered inside the phase bar's own row, so each
          visit gets genuine vertical space of its own rather than
          overlapping. declined visits are excluded (nothing useful to
          show/drag for a trade who said no) — every other status is
          rendered by VisitSubBar. Portal TimelineSection.tsx is
          untouched: this entire block only exists inside GanttChart.tsx,
          which the read-only portal mirror never imports from. */}
      {isExpanded && phase.visits.length > 0 && (
        <>
          <div className="sticky left-0 z-10 col-start-1 border-b border-r border-[#e5e0d6] bg-nearwhite" />
          <div className="relative border-b border-[#e5e0d6] py-1" style={{ gridColumn: `2 / span ${weekCount}` }}>
            {phase.visits
              .filter((v) => v.status !== "declined")
              .map((visit) => {
                const drag = visitDragState && visitDragState.visitId === visit.id ? visitDragState : null;
                return (
                  <div key={visit.id}>
                    <VisitSubBar
                      visit={visit}
                      grid={grid}
                      weekCount={weekCount}
                      zoom={zoom}
                      dragMode={drag?.mode ?? null}
                      dragDeltaDays={drag?.deltaDays ?? 0}
                      onStartDrag={(mode, clientX) => onStartVisitDrag(visit, mode, clientX)}
                      onClick={() => onTapVisit(visit)}
                    />
                    {reconfirmPrompts.has(visit.id) && (
                      <ReconfirmAffordance
                        onResend={() => onResendConfirmation(visit.id)}
                        onDismiss={() => onDismissReconfirm(visit.id)}
                      />
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}

      {editing && (
        <div className="col-span-full border-b border-[#dcd6cc] bg-offwhite px-3 py-3">
          <PhaseEditPanel
            phase={phase}
            onPatch={onPatch}
            onDelete={onDelete}
            onAddVisit={onAddVisit}
            onPatchVisit={onPatchVisit}
            onDeleteVisit={onDeleteVisit}
            forceOpenAddVisit={forceOpenAddVisit}
            onAddVisitOpened={onAddVisitOpened}
          />
        </div>
      )}
    </>
  );
}

function PhaseEditPanel({
  phase,
  onPatch,
  onDelete,
  onAddVisit,
  onPatchVisit,
  onDeleteVisit,
  forceOpenAddVisit,
  onAddVisitOpened,
}: {
  phase: SchedulePhaseWithVisits;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<SchedulePhaseWithVisits>) => void;
  onDelete: () => void;
  onAddVisit: (visit: TradeVisitWithContact) => void;
  onPatchVisit: (visit: TradeVisitWithContact) => void;
  onDeleteVisit: (visitId: string) => void;
  /** Round A "Book trade" context-menu action. */
  forceOpenAddVisit: boolean;
  onAddVisitOpened: () => void;
}) {
  const [name, setName] = useState(phase.name);
  const [start, setStart] = useState(phase.start_date);
  const [end, setEnd] = useState(phase.end_date);
  const [notes, setNotes] = useState(phase.notes ?? "");
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Board cockpit round — fetch-once-on-mount (this panel is already
  // only mounted once a phase row is expanded, so "on mount" here is
  // already equivalent to BookVisitPanel's own "fetch on open" — no
  // extra open/close toggle state needed now that the shared
  // ContactPicker owns its own dropdown-open state internally).
  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, []);

  // Umbrella phases render via components/gantt/UmbrellaBand.tsx
  // instead of this ordinary edit form (UmbrellaBand has its own
  // inline date editor as of Fix Round A, plus the read-only
  // Preliminaries & Site content panel). This branch exists
  // defensively (an umbrella row should never reach PhaseEditPanel
  // since GanttChart.tsx renders umbrellas via <UmbrellaBand> instead
  // of <PhaseRow>), but is kept here in case that invariant is ever
  // broken by a future change.
  if (phase.kind === "umbrella") {
    return (
      <div>
        <p className="label-caps mb-2">Preliminaries & Site content</p>
        <ul className="list-disc space-y-1 pl-4">
          {(phase.cost_section_lines ?? []).map((line, i) => (
            <li key={i} className="text-body text-charcoal">
              {line}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== phase.name && onPatch({ name: name.trim() })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Start date</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onBlur={() => start !== phase.start_date && onPatch({ start_date: start })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">End date</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={() => end !== phase.end_date && onPatch({ end_date: end })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Colour</span>
          <div className="flex items-center gap-1.5">
            {COLOR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onPatch({ color_key: key })}
                title={key}
                className={clsx(
                  "h-6 w-6 border",
                  phase.color_key === key ? "border-nearblack" : "border-transparent"
                )}
                style={{ backgroundColor: COLOR_SWATCH[key] }}
              />
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="label-caps">Notes</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => (notes.trim() || null) !== phase.notes && onPatch({ notes: notes.trim() || null })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="label-caps">Contact</span>
          {/* Board cockpit round — swapped the inline open/close +
              manual list for the shared ContactPicker (item 6: "shared
              searchable ContactPicker replacing existing pickers").
              Same onPatch/refUpdate call-site behaviour as before —
              only the picker UI internals changed. */}
          <ContactPicker
            contacts={contacts}
            selectedId={phase.contact_id}
            placeholder="None"
            onSelect={(contactId) => {
              if (!contactId) {
                onPatch({ contact_id: null }, { contact: null });
                return;
              }
              const c = contacts.find((x) => x.id === contactId);
              onPatch(
                { contact_id: contactId },
                { contact: c ? { id: c.id, company: c.company, contact_name: c.contact_name } : null }
              );
            }}
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={onDelete}
            className="border border-red-700/40 px-3 py-1.5 text-subhead text-red-700 transition-colors hover:bg-red-700 hover:text-white"
          >
            Remove phase
          </button>
        </div>
      </div>

      <VisitsPanel
        phase={phase}
        onAddVisit={onAddVisit}
        onPatchVisit={onPatchVisit}
        onDeleteVisit={onDeleteVisit}
        forceOpenAdding={forceOpenAddVisit}
        onAddingOpened={onAddVisitOpened}
      />
    </div>
  );
}

/**
 * Visit list + add-visit mini-form, nested inside the phase edit
 * panel — the "full detail" half of the rendering decision described
 * at the top of this file. Contact picker reuses the SAME
 * /api/contacts fetch pattern already used by the phase-level contact
 * picker above.
 */
function VisitsPanel({
  phase,
  onAddVisit,
  onPatchVisit,
  onDeleteVisit,
  forceOpenAdding,
  onAddingOpened,
}: {
  phase: SchedulePhaseWithVisits;
  onAddVisit: (visit: TradeVisitWithContact) => void;
  onPatchVisit: (visit: TradeVisitWithContact) => void;
  onDeleteVisit: (visitId: string) => void;
  /** Round A "Book trade" context-menu action — opens this panel's add-visit mini-form immediately, on top of the phase edit panel GanttChart.tsx already expands. */
  forceOpenAdding?: boolean;
  onAddingOpened?: () => void;
}) {
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (forceOpenAdding && !adding) {
      setAdding(true);
      onAddingOpened?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpenAdding]);

  return (
    <div className="border-t border-[#dcd6cc] pt-3">
      <p className="label-caps mb-2">Trade visits</p>
      {phase.visits.length === 0 ? (
        <p className="mb-2 text-body text-charcoal/50">No visits scheduled yet.</p>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {phase.visits.map((visit) => (
            <VisitRow key={visit.id} visit={visit} onPatch={onPatchVisit} onDelete={onDeleteVisit} />
          ))}
        </ul>
      )}

      {adding ? (
        <AddVisitForm
          projectId={phase.project_id}
          phaseId={phase.id}
          onAdded={(v) => {
            onAddVisit(v);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
        >
          + Add visit
        </button>
      )}
    </div>
  );
}

function VisitRow({
  visit,
  onPatch,
  onDelete,
}: {
  visit: TradeVisitWithContact;
  onPatch: (visit: TradeVisitWithContact) => void;
  onDelete: (visitId: string) => void;
}) {
  const [start, setStart] = useState(visit.start_date);
  const [end, setEnd] = useState(visit.end_date);

  async function patch(patch: Record<string, unknown>) {
    const res = await fetch(`/api/visits/${visit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const { visit: updated } = await res.json();
      onPatch({ ...visit, ...updated });
    }
  }

  async function remove() {
    if (!confirm("Remove this visit?")) return;
    const res = await fetch(`/api/visits/${visit.id}`, { method: "DELETE" });
    if (res.ok) onDelete(visit.id);
  }

  return (
    <li id={`focus-trade_proposal-${visit.id}`} className="flex flex-wrap items-center gap-2 border-b border-[#e5e0d6] pb-1.5 text-body">
      <span className="min-w-[110px] text-charcoal">{visit.contact?.company ?? "No trade"}</span>
      <input
        type="date"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={() => start !== visit.start_date && patch({ start_date: start })}
        className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
      />
      <input
        type="date"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={() => end !== visit.end_date && patch({ end_date: end })}
        className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
      />
      <span className="text-caption text-charcoal/50">{formatArrival(visit.arrival_slot, visit.arrival_time)}</span>
      <VisitStatusLabel status={visit.status} />
      <button type="button" onClick={remove} className="ml-auto text-caption text-red-700 hover:underline">
        Remove
      </button>
    </li>
  );
}

const SLOT_OPTIONS: { key: ArrivalSlot; label: string }[] = [
  { key: "first_thing", label: "First thing" },
  { key: "midday", label: "Midday" },
  { key: "afternoon", label: "Afternoon" },
];

function AddVisitForm({
  projectId,
  phaseId,
  onAdded,
  onCancel,
}: {
  projectId: string;
  phaseId: string;
  onAdded: (visit: TradeVisitWithContact) => void;
  onCancel: () => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState<string>("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [slot, setSlot] = useState<ArrivalSlot | "">("");
  const [time, setTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fix Round A — Trade insurance tracker: non-blocking warning
  // surfaced from the API response's insurance_warning flag (see
  // POST /api/projects/[id]/visits' doc comment). Shown alongside the
  // just-added visit rather than blocking the add — the visit is
  // already booked by the time this renders.
  const [insuranceWarning, setInsuranceWarning] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!start || !end) return;
    setSubmitting(true);
    setError(null);
    setInsuranceWarning(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/visits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase_id: phaseId,
          contact_id: contactId || null,
          start_date: start,
          end_date: end,
          arrival_slot: slot || null,
          arrival_time: time || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add visit.");
      const { visit, insurance_warning } = await res.json();
      const contact = contacts.find((c) => c.id === contactId) ?? null;
      onAdded({ ...visit, contact: contact ? { id: contact.id, company: contact.company, contact_name: contact.contact_name } : null });
      if (insurance_warning) setInsuranceWarning(insurance_warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add visit.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border border-[#c9c2b4] bg-nearwhite p-3">
      {error && <p className="w-full text-caption text-red-700">{error}</p>}
      {insuranceWarning && (
        <p className="w-full border border-sand bg-cream px-2 py-1.5 text-caption text-charcoal">
          {insuranceWarning}
        </p>
      )}
      <div className="min-w-[140px]">
        <label className="text-caption text-charcoal/60">Trade</label>
        {/* Board cockpit round — item 6: this booking form's Trade
            field was a plain <select> (no search, no keyboard nav
            beyond the browser's own native select behaviour) — swapped
            for the shared ContactPicker. Same call-site behaviour as
            before: contactId stays a plain string (empty = none) so
            the rest of this form/submit() is untouched, only the
            picker UI itself changed. */}
        <div className="mt-1">
          <ContactPicker
            contacts={contacts}
            selectedId={contactId || null}
            placeholder="None"
            onSelect={(id) => setContactId(id ?? "")}
          />
        </div>
      </div>
      <div>
        <label className="text-caption text-charcoal/60">Start</label>
        <input
          type="date"
          required
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="text-caption text-charcoal/60">End</label>
        <input
          type="date"
          required
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="text-caption text-charcoal/60">Arrival</label>
        <select
          value={slot}
          onChange={(e) => setSlot(e.target.value as ArrivalSlot | "")}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        >
          <option value="">—</option>
          {SLOT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-caption text-charcoal/60">Or time</label>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
      >
        Cancel
      </button>
    </form>
  );
}

function AddPhaseForm({
  onAdd,
  onCancel,
  initialStart,
}: {
  onAdd: (input: { name: string; start_date: string; end_date: string; color_key: PhaseColorKey }) => void;
  onCancel: () => void;
  /** Round A "Add phase starting this week" (right-click empty timeline space) — prefills the start date; the form otherwise behaves identically to the plain "+ Add phase" entry point. */
  initialStart?: string | null;
}) {
  const [name, setName] = useState("");
  const [start, setStart] = useState(initialStart ?? "");
  const [end, setEnd] = useState("");
  const [color, setColor] = useState<PhaseColorKey>("sand");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !start || !end) return;
    setSubmitting(true);
    try {
      await onAdd({ name: name.trim(), start_date: start, end_date: end, color_key: color });
      setName("");
      setStart("");
      setEnd("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="min-w-[200px] flex-1">
        <label className="label-caps mb-1 block">Name</label>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Demolition"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">Start</label>
        <input
          type="date"
          required
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">End</label>
        <input
          type="date"
          required
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">Colour</label>
        <div className="flex items-center gap-1.5 py-1">
          {COLOR_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setColor(key)}
              title={key}
              className={clsx("h-6 w-6 border", color === key ? "border-nearblack" : "border-transparent")}
              style={{ backgroundColor: COLOR_SWATCH[key] }}
            />
          ))}
        </div>
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
      >
        Cancel
      </button>
    </form>
  );
}
