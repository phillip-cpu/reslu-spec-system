// ============================================================
// Round A — "Board owns dates, Timeline is the visual" §"Timeline
// slider bars". Pure date-math helpers for dragging a Gantt bar,
// deliberately kept separate from lib/gantt.ts (which stays a "dates
// -> grid coordinates" module, per that file's own header comment)
// since this is the inverse direction: "pixel delta -> date delta",
// used only by the pointer-drag interaction in
// components/gantt/GanttChart.tsx (or a usePhaseDrag hook consuming
// it), never by the read-only grid-position math itself.
//
// Consistency with lib/gantt.ts's grid: a week column is
// `(100% / weekCount)` wide (see phaseGridPosition's marginLeft/width
// formula in GanttChart.tsx). This module's callers measure that same
// column's rendered pixel width at drag-start (via getBoundingClientRect
// on the row's grid-column-spanning wrapper, divided by weekCount) and
// pass it in as `columnPx` — this file has zero DOM access itself, so
// it can't drift from the grid math on its own; it only ever receives
// numbers the caller already derived from the exact same grid.
// ============================================================

const MS_PER_DAY = 86_400_000;

function parseDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** Whole-day difference between two ISO date strings (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / MS_PER_DAY);
}

/**
 * Pixels-per-day for the shared week grid — BUILD-SPEC.md "day-snapped
 * ... computed from the existing week-grid math: px-per-day =
 * column width / 7". `weekColumnPx` is the caller-measured rendered
 * width of ONE week column (the same column the `calc((100% /
 * weekCount) * ...)` formula in GanttChart.tsx divides the grid into).
 */
export function pxPerDay(weekColumnPx: number): number {
  return weekColumnPx / 7;
}

/** Snap a raw pixel delta to a whole number of days, given px-per-day. */
export function snapDeltaDays(deltaPx: number, weekColumnPx: number): number {
  const perDay = pxPerDay(weekColumnPx);
  if (!perDay || !Number.isFinite(perDay)) return 0;
  return Math.round(deltaPx / perDay);
}

/**
 * Timeline Day-zoom polish round — day-snapping variant for the
 * WINDOWED grid (lib/gantt-window.ts), used whenever GanttChart.tsx's
 * zoom is 'day' or 'week'. Takes an already-known px-per-day directly
 * (rather than a week-column width divided by 7 like snapDeltaDays
 * above) since the windowed grid has no "week column" to measure at
 * all — GanttChart.tsx measures `bodyWidthPx / win.days` via
 * lib/gantt-window.ts's windowPxPerDay() and passes the result straight
 * through here. Kept as a separate, tiny function (not a re-parametrised
 * snapDeltaDays) so neither this file's existing Month-zoom callers nor
 * its existing signature need to change — this round's brief is
 * explicit that drag snapping must measure its day width "from the same
 * source" as the windowed bar geometry, and a shared source is exactly
 * what this function's caller (GanttChart.tsx) now uses for both.
 */
export function snapDeltaDaysFromPxPerDay(deltaPx: number, dayWidthPx: number): number {
  if (!dayWidthPx || !Number.isFinite(dayWidthPx)) return 0;
  return Math.round(deltaPx / dayWidthPx);
}

export type DragMode = "move" | "resize-start" | "resize-end";

export interface DragResult {
  start_date: string;
  end_date: string;
}

/**
 * Applies a day-snapped drag delta to a phase's date range, per
 * BUILD-SPEC.md "Timeline slider bars":
 *   - "move" (grab bar body): start+end shift equally.
 *   - "resize-start" (grab left 6px edge zone): only start_date moves;
 *     clamped so the phase never drops below 1 day duration.
 *   - "resize-end" (grab right 6px edge zone): only end_date moves;
 *     same 1-day-minimum clamp.
 */
export function applyDrag(
  original: { start_date: string; end_date: string },
  mode: DragMode,
  deltaDays: number
): DragResult {
  if (deltaDays === 0) return { start_date: original.start_date, end_date: original.end_date };

  if (mode === "move") {
    return {
      start_date: addDays(original.start_date, deltaDays),
      end_date: addDays(original.end_date, deltaDays),
    };
  }

  // "resize-start"/"resize-end": durationDays is inclusive whole days
  // between the two dates (daysBetween's raw diff, e.g. 4 days between
  // Jan 1 and Jan 5) — clamped to `durationDays - 1` so the edge being
  // dragged can never cross past 1 day short of the OTHER edge,
  // enforcing the spec's "min duration 1 day".
  if (mode === "resize-start") {
    const durationDays = daysBetween(original.start_date, original.end_date);
    const maxDelta = durationDays - 1; // start can move right at most to end_date - 1 day (min 1-day duration)
    const clamped = Math.min(deltaDays, maxDelta);
    return { start_date: addDays(original.start_date, clamped), end_date: original.end_date };
  }

  // resize-end
  const durationDays = daysBetween(original.start_date, original.end_date);
  const minDelta = -(durationDays - 1); // end can move left at most to start_date + 1 day (min 1-day duration)
  const clamped = Math.max(deltaDays, minDelta);
  return { start_date: original.start_date, end_date: addDays(original.end_date, clamped) };
}
