"use client";

import { useRef } from "react";
import clsx from "clsx";
import type { TradeVisitWithContact } from "@/lib/trade-visits";
import { formatArrival } from "@/lib/trade-visits";
import { visitGridPosition, type GanttGrid } from "@/lib/gantt";
import { dragTransform, windowedPosition, type GanttWindow } from "@/lib/gantt-window";
import type { DragMode } from "@/lib/phase-drag";

/** Edge zone width for a visit sub-bar — deliberately kept at 6px (NOT widened to the phase bar's new 10px this round) since sub-bars are already the thinnest bar in the Gantt; a 10px edge zone would eat too much of an already-narrow bar's centre "move" region. BUILD-SPEC item 4's "10px edge zones" ask is scoped to phase/umbrella bars — see GanttChart.tsx's own EDGE_ZONE_PX doc comment. */
const EDGE_ZONE_PX = 6;

/**
 * One trade-visit sub-bar — BUILD-SPEC.md "Internal timeline — trade
 * visit sub-bars": a thin sub-row per visit revealed when a phase row
 * is expanded, spanning start->end date using the SAME grid positioning
 * function as phase bars (visitGridPosition, which is a thin wrapper
 * around lib/gantt.ts's phaseGridPosition — see that function's own
 * doc comment: visits are positioned in the identical week-grid
 * coordinate space as phase bars, not a second coordinate system).
 *
 * Status styling (BUILD-SPEC): confirmed = solid charcoal fill;
 * unconfirmed/tentative = dashed sand border (no fill — visually
 * lighter than a confirmed bar, matching the portal's existing
 * confirmed/unconfirmed visual convention); proposed_change = amber
 * highlight (a trade has countered and staff needs to act). declined
 * visits are excluded upstream (GanttChart.tsx never renders a
 * declined visit as a sub-bar — see its filter) so this component only
 * ever needs to handle the four statuses actually reachable here.
 *
 * Drag/resize: reuses lib/phase-drag.ts's applyDrag/snapDeltaDays —
 * the EXACT SAME functions PhaseRow's drag handling uses in
 * GanttChart.tsx — via the onStartDrag callback prop, which the parent
 * wires to its OWN startDrag()-equivalent for visits (see
 * GanttChart.tsx's startVisitDrag). This component itself has zero
 * date-math of its own; it only reports pointer gestures upward,
 * mirroring PhaseRow's pointer-handling split exactly.
 */
export function VisitSubBar({
  visit,
  grid,
  weekCount,
  win = null,
  zoom,
  dragMode,
  dragDeltaDays,
  onStartDrag,
  onClick,
}: {
  visit: TradeVisitWithContact;
  grid: GanttGrid;
  weekCount: number;
  /**
   * Timeline Day-zoom polish round — the shared visible window
   * (lib/gantt-window.ts), passed by GanttChart.tsx whenever zoom is
   * 'day'/'week'; null at Month zoom, where this component falls back
   * to its original lib/gantt.ts week-grid math (visitGridPosition)
   * exactly as before. Visit sub-bars are explicitly one of the "ALL
   * move to the same windowed math" elements BUILD-SPEC item 3 calls
   * out — before this round they shared the exact same week-granularity
   * bug phase bars did.
   */
  win?: GanttWindow | null;
  zoom: "day" | "week" | "month";
  dragMode: DragMode | null;
  dragDeltaDays: number;
  onStartDrag: (mode: DragMode, clientX: number) => void;
  onClick: () => void;
}) {
  const pos = visitGridPosition(visit, grid);
  const winPos = win ? windowedPosition(visit, win) : null;
  const dragging = dragMode !== null;

  if (winPos && !winPos.visible) return null;
  // Tracks whether the current mouse gesture actually MOVED (not just
  // "a pointerdown happened") — a plain click has a pointerdown with
  // zero subsequent movement, and must still open the visit sheet.
  // Only a genuine drag (real pixel movement past DRAG_THRESHOLD_PX)
  // suppresses the click-to-open below, via its own tiny local
  // pointermove/pointerup listener pair — deliberately separate from
  // GanttChart.tsx's startVisitDrag listeners (which always attach and
  // track day-snapped deltas for the actual PATCH regardless of
  // distance moved); this ref only decides "was this a click or a
  // drag" for THIS component's own onClick suppression.
  const draggedRef = useRef(false);

  const companyLabel = visit.contact?.company ?? "Trade";
  const arrivalLabel = formatArrival(visit.arrival_slot, visit.arrival_time);
  const label = `${companyLabel} · ${arrivalLabel}`;
  const tooltip = [
    `Trade: ${companyLabel}`,
    `Arrives: ${visit.start_date} — ${arrivalLabel}`,
    `Finishes: ${visit.end_date}`,
    `Status: ${statusLabel(visit.status)}`,
    visit.notes ? `Notes: ${visit.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return; // touch: tap-to-open only, same as phase bars
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const mode: DragMode =
      offsetX <= EDGE_ZONE_PX ? "resize-start" : offsetX >= rect.width - EDGE_ZONE_PX ? "resize-end" : "move";
    draggedRef.current = false;
    onStartDrag(mode, e.clientX);

    // Local-only movement watch (see draggedRef's own doc comment
    // above) — separate listener pair from GanttChart.tsx's own
    // startVisitDrag pointermove/pointerup (which always attaches
    // regardless of distance, to compute the day-snapped PATCH delta).
    // DRAG_THRESHOLD_PX mirrors ordinary browser click-vs-drag
    // tolerance (a few pixels of unavoidable mouse jitter on a genuine
    // click must not be misread as a drag).
    const startX = e.clientX;
    const DRAG_THRESHOLD_PX = 3;
    function onMove(ev: PointerEvent) {
      if (Math.abs(ev.clientX - startX) > DRAG_THRESHOLD_PX) {
        draggedRef.current = true;
      }
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function handleClick() {
    // Suppresses the click-to-open ONLY when the mouse actually moved
    // past the threshold above (a real drag) — a plain click (zero
    // movement) still opens the visit sheet, see draggedRef's doc
    // comment for why this guard exists at all.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onClick();
  }

  const wrapperStyle: React.CSSProperties = winPos
    ? { position: "absolute", left: `${winPos.leftPct}%`, width: `${winPos.widthPct}%` }
    : {
        marginLeft: `calc((100% / ${weekCount}) * ${pos.startCol - 1 + (dragMode === "move" || dragMode === "resize-start" ? dragDeltaDays / 7 : 0)})`,
        width: `calc((100% / ${weekCount}) * ${pos.span + (dragMode === "resize-start" ? -dragDeltaDays / 7 : dragMode === "resize-end" ? dragDeltaDays / 7 : 0)})`,
      };
  const dragStyle: React.CSSProperties =
    winPos && dragging && win
      ? {
          transform: dragTransform(dragMode, dragDeltaDays, win.days, winPos.widthPct),
          transformOrigin: dragMode === "resize-end" ? "left" : "right",
        }
      : {};

  return (
    <div style={winPos ? { position: "relative", height: "1rem" } : undefined}>
      <div
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        title={tooltip}
        className={clsx(
          "relative mt-0.5 flex h-3.5 cursor-grab items-center overflow-hidden text-[10px] leading-none",
          dragging ? "cursor-grabbing opacity-70 outline outline-1 outline-nearblack transition-none" : "transition-opacity",
          visit.status === "confirmed" && "bg-charcoal text-white",
          (visit.status === "unconfirmed" || visit.status === "tentative") &&
            "border border-dashed border-sand bg-transparent text-charcoal",
          visit.status === "proposed_change" && "border border-amber-600 bg-[#B98A4A] text-white"
        )}
        style={{ ...wrapperStyle, ...dragStyle }}
      >
        {/* Day zoom: arrival time/label shown directly on the bar (BUILD-
            SPEC "Day zoom: arrival time shown on the bar"). Week/Month:
            no on-bar text (bars are too narrow at those zooms — full
            detail lives in the `title` tooltip above instead, per
            BUILD-SPEC "Week/Month: on hover tooltip"). */}
        {zoom === "day" && <span className="truncate px-1">{label}</span>}
        {/* Continuation chevrons — item 3's "½ chevron" ask, same
            convention as the phase bar/umbrella band. */}
        {winPos?.clippedStart && (
          <span className="absolute -left-2 top-1/2 -translate-y-1/2 text-[9px] text-charcoal/60">◂</span>
        )}
        {winPos?.clippedEnd && (
          <span className="absolute -right-2 top-1/2 -translate-y-1/2 text-[9px] text-charcoal/60">▸</span>
        )}
      </div>
    </div>
  );
}

function statusLabel(status: TradeVisitWithContact["status"]): string {
  switch (status) {
    case "confirmed":
      return "Confirmed";
    case "tentative":
      return "Tentative";
    case "unconfirmed":
      return "Unconfirmed";
    case "proposed_change":
      return "Proposed change (awaiting staff decision)";
    case "declined":
      return "Declined";
    default:
      return status;
  }
}
