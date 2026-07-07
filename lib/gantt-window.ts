// ============================================================
// RESLU Spec System — Timeline Day-zoom polish (7 July 2026 round).
// Windowed, DAY-granularity geometry for the internal Gantt
// (components/gantt/GanttChart.tsx) at Day and Week zoom.
//
// ROOT CAUSE this file fixes (BUILD-SPEC.md "Timeline Day-zoom polish"
// item 3, "Bar-scale bug"): the Board cockpit round added Day zoom by
// widening each WEEK column's CSS minmax floor (GanttChart.tsx's
// `colMinWidth`) without ever touching lib/gantt.ts's grid math — every
// bar's left/width is still `(100% / weekCount) * <whole-week offset/
// span>` (see phaseGridPosition in lib/gantt.ts). That formula is
// correct for WEEK-granularity columns, but at Day zoom each rendered
// "week column" is just a wider box — a phase's bar is still
// positioned/sized in whole WEEK units, so e.g. a 3-day phase starting
// mid-week renders as a full week-column-width bar (spanning the WHOLE
// week it starts in, not 3/7 of it), and two phases with different
// day-offsets *within* the same week column can render at the same
// horizontal position. That is exactly the "bars render inconsistent
// widths vs their date ranges" symptom from Phillip's screenshot.
//
// THE FIX: a single source of truth for "visible window + px-per-day"
// that every bar-shaped thing (phase bars, the umbrella band, visit
// sub-bars, task tick markers, milestone diamonds, the today line, drag
// snapping) reads from, so nothing can independently drift back into
// week-granularity math. This module owns:
//   - a "visible window" (a contiguous run of calendar days — NOT
//     weeks) that Day/Week zoom scroll through via ◀ ▶ / Today / arrow
//     keys (item 2);
//   - percentage-based day-offset positioning within that window,
//     clipped at the window edges with a flag so the caller can render
//     a continuation chevron (item 3's "½ chevron" ask);
//   - the exact same day-width the drag code (lib/phase-drag.ts) must
//     measure from, so a dragged pixel delta and a rendered bar's width
//     can never disagree about how many pixels one day is worth.
//
// Month zoom is UNCHANGED — it deliberately keeps rendering the entire
// project span via lib/gantt.ts's existing week-based
// computeGanttGrid/phaseGridPosition (BUILD-SPEC.md: "Month zoom keeps
// showing everything — no nav needed"), so this module is only ever
// consulted by GanttChart.tsx when zoom is 'day' or 'week'.
//
// Portal TimelineSection.tsx is COMPLETELY UNTOUCHED by this round — it
// keeps using lib/gantt.ts's original whole-project week grid, which
// remains exactly as it was (this file adds a new module; it does not
// modify lib/gantt.ts at all).
// ============================================================

const MS_PER_DAY = 86_400_000;

export interface DateRange {
  start_date: string;
  end_date: string;
}

function parseDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Whole-day difference between two ISO date strings (b - a), UTC/date-only safe. */
export function daysBetweenDates(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / MS_PER_DAY);
}

/** Monday-aligned start of the week containing `date`. Mirrors lib/gantt.ts's own startOfWeek — duplicated (not imported) so this module has zero dependency on lib/gantt.ts's internals, matching that file's own "fully self-contained" convention for sibling grid-math modules (see lib/trade-visits.ts's header comment on the same pattern). */
function startOfWeekUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** Zoom levels this module serves. Month is intentionally absent from every function below — GanttChart.tsx never calls into this module at Month zoom. */
export type WindowZoom = "day" | "week";

/** Calendar days visible at once per zoom — BUILD-SPEC item 2's nav "flicks the visible window through weeks/months": Day zoom shows a fortnight at a time (enough to read day-of-month + weekday without the columns becoming illegibly thin), Week zoom shows a full quarter. */
const WINDOW_DAYS: Record<WindowZoom, number> = {
  day: 14,
  week: 84, // 12 weeks
};

/** How far ◀ ▶ shifts the window per click — a full window-width jump for Week zoom (page through quarters), a week at a time for Day zoom (finer control since the window itself is already narrow). */
const STEP_DAYS: Record<WindowZoom, number> = {
  day: 7,
  week: 28,
};

export interface GanttWindow {
  zoom: WindowZoom;
  /** First visible calendar day (inclusive). */
  start: Date;
  /** Number of visible calendar days (== WINDOW_DAYS[zoom]). */
  days: number;
  /** One Date per visible day, `start` .. `start + days - 1`. */
  dayList: Date[];
}

function buildWindow(zoom: WindowZoom, start: Date): GanttWindow {
  const days = WINDOW_DAYS[zoom];
  const dayList: Date[] = [];
  for (let i = 0; i < days; i++) dayList.push(addDays(start, i));
  return { zoom, start, days, dayList };
}

/**
 * Default window — BUILD-SPEC item 2: "window defaults to containing
 * today or the earliest phase." Prefers a window starting at the
 * Monday of today's week (so "today" reads naturally near the left
 * edge rather than mid-window) PROVIDED today falls within or after the
 * earliest phase's start; if every phase starts in the future, the
 * window instead opens on the Monday of the EARLIEST phase's start
 * week, so a project scheduled to begin next month doesn't open on an
 * empty, all-past-looking window.
 */
export function defaultWindow(zoom: WindowZoom, phases: DateRange[], now: Date = new Date()): GanttWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (phases.length === 0) {
    return buildWindow(zoom, startOfWeekUTC(today));
  }
  const earliestStart = phases.reduce((min, p) => {
    const t = parseDate(p.start_date);
    return t.getTime() < min.getTime() ? t : min;
  }, parseDate(phases[0].start_date));

  const anchor = earliestStart.getTime() > today.getTime() ? earliestStart : today;
  return buildWindow(zoom, startOfWeekUTC(anchor));
}

/** Shift the window by one ◀/▶ "page" (STEP_DAYS), or an arbitrary day delta (used by keyboard ←/→, which BUILD-SPEC item 2 says should also nav — one day at a time feels more like "nudge" than "page", so arrow keys pass their own smaller delta rather than reusing the button's STEP_DAYS; see GanttChart.tsx's keydown handler). */
export function shiftWindow(win: GanttWindow, deltaDays: number): GanttWindow {
  return buildWindow(win.zoom, addDays(win.start, deltaDays));
}

/** The ◀ ▶ buttons' step size for a given zoom (exported so GanttChart.tsx's button onClick handlers and this module never disagree about "one page"). */
export function windowStepDays(zoom: WindowZoom): number {
  return STEP_DAYS[zoom];
}

/** Re-centres the window on today — the "Today" nav button. */
export function windowToToday(zoom: WindowZoom, now: Date = new Date()): GanttWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return buildWindow(zoom, startOfWeekUTC(today));
}

/** Rebuilds a window at a new zoom level, keeping the same start-of-window day (a zoom toggle mid-navigation shouldn't also silently jump the visible dates back to "today"). */
export function rezoomWindow(win: GanttWindow, zoom: WindowZoom): GanttWindow {
  return buildWindow(zoom, win.start);
}

/** "21 Jul – 3 Aug" — BUILD-SPEC item 2's visible-range label. Cross-year ranges include the year on both ends; same-year ranges omit it (matches lib/gantt.ts's monthLabel's own en-AU short-month convention). */
export function formatWindowRange(win: GanttWindow): string {
  const last = win.dayList[win.dayList.length - 1];
  const sameYear = win.start.getUTCFullYear() === last.getUTCFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" };
  const startLabel = win.start.toLocaleDateString("en-AU", opts);
  const endLabel = last.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
  return `${startLabel} – ${endLabel}`;
}

// ------------------------------------------------------------
// Bar/marker geometry — the actual bug fix. Every value below is a
// PERCENTAGE (0–100) of the window's total width, computed from exact
// day offsets, so a bar's rendered width is always
// `(days-in-range / window.days) * 100%` regardless of which week of
// the window a phase happens to start in. This replaces
// lib/gantt.ts's week-granularity phaseGridPosition/visitGridPosition/
// umbrellaGridPosition for every caller inside the Day/Week-zoomed
// Gantt — lib/gantt.ts itself is untouched (Month zoom and the portal
// mirror still use it directly).
// ------------------------------------------------------------

export interface WindowedBarPosition {
  /** Left offset as a percentage (0–100) of the window's width. */
  leftPct: number;
  /** Width as a percentage (0–100) of the window's width. Always > 0 (a fully-offscreen range is signalled via `visible: false`, not a zero/negative width). */
  widthPct: number;
  /** False if the range doesn't intersect the visible window at all — caller should skip rendering. */
  visible: boolean;
  /** True if the range's start_date is before the window's first visible day — render a "◂" continuation chevron on the left edge. */
  clippedStart: boolean;
  /** True if the range's end_date is after the window's last visible day — render a "▸" continuation chevron on the right edge. */
  clippedEnd: boolean;
}

/**
 * Maps any date range (phase, umbrella, visit, or a synthetic
 * single-day range for a marker/today-line) onto the current window as
 * exact day-offset percentages, clipped cleanly at the window edges.
 * This is THE single function every bar-shaped element in
 * GanttChart.tsx must call at Day/Week zoom — phases, umbrella band,
 * visit sub-bars, task tick markers, milestone diamonds, and the today
 * line all funnel through this one function so they can never drift
 * onto different geometry.
 */
export function windowedPosition(range: DateRange, win: GanttWindow): WindowedBarPosition {
  const windowStart = win.start.getTime();
  const windowEndExclusive = addDays(win.start, win.days).getTime(); // one day past the last visible day
  const rangeStart = parseDate(range.start_date).getTime();
  // end_date is inclusive (matches lib/gantt.ts's convention — a phase
  // running Jul 22 -> Jul 25 covers 4 calendar days) so the exclusive
  // boundary is one day past end_date.
  const rangeEndExclusive = addDays(parseDate(range.end_date), 1).getTime();

  if (rangeEndExclusive <= windowStart || rangeStart >= windowEndExclusive) {
    return { leftPct: 0, widthPct: 0, visible: false, clippedStart: false, clippedEnd: false };
  }

  const clippedStart = rangeStart < windowStart;
  const clippedEnd = rangeEndExclusive > windowEndExclusive;

  const visibleStart = Math.max(rangeStart, windowStart);
  const visibleEndExclusive = Math.min(rangeEndExclusive, windowEndExclusive);

  const startOffsetDays = (visibleStart - windowStart) / MS_PER_DAY;
  const visibleDays = (visibleEndExclusive - visibleStart) / MS_PER_DAY;

  const leftPct = (startOffsetDays / win.days) * 100;
  const widthPct = Math.max((visibleDays / win.days) * 100, 100 / win.days / 4); // never fully collapse a genuinely-visible sliver below a hairline

  return { leftPct, widthPct, visible: true, clippedStart, clippedEnd };
}

/** Convenience wrapper for a single-day marker (today line, task due/booking ticks, milestone diamonds) — same clipping/percentage math as windowedPosition, just pre-shaped as a zero-duration range. */
export function windowedMarkerPosition(dateStr: string, win: GanttWindow): WindowedBarPosition {
  return windowedPosition({ start_date: dateStr, end_date: dateStr }, win);
}

/** True if `dateStr` falls on any visible day of the window — used to decide whether to render the today-highlight column (item 1). */
export function windowContainsDate(dateStr: string, win: GanttWindow): boolean {
  const t = parseDate(dateStr).getTime();
  const windowStart = win.start.getTime();
  const windowEndExclusive = addDays(win.start, win.days).getTime();
  return t >= windowStart && t < windowEndExclusive;
}

// ------------------------------------------------------------
// Drag geometry — the same window feeds lib/phase-drag.ts's
// pxPerDay/snapDeltaDays. Those functions already take a caller-
// measured `dayWidthPx`/`weekColumnPx` number and have zero DOM access
// of their own (see that file's header comment); this module's job is
// only to make sure GanttChart.tsx measures a DAY's pixel width from
// THIS window's day count, not from lib/gantt.ts's week count, whenever
// zoom is 'day'/'week'. See lib/phase-drag.ts's dayWidthFromWindow()
// helper (added this round) for the actual measurement helper used at
// drag-start.
// ------------------------------------------------------------

/** Pixels-per-day for a rendered window body of `bodyWidthPx` — the Day/Week-zoom analogue of lib/phase-drag.ts's pxPerDay(weekColumnPx), expressed directly in the window's own day count instead of assuming 7 days/column. */
export function windowPxPerDay(bodyWidthPx: number, win: GanttWindow): number {
  if (!win.days) return 0;
  return bodyWidthPx / win.days;
}

/**
 * BUILD-SPEC item 4 "smoother sliding": a CSS `transform: translateX()`
 * string expressing a live drag's preview purely as a percentage of the
 * BAR'S OWN rendered box (CSS `translateX(<pct>%)` is relative to the
 * element's own border box) — never the window's width — so the exact
 * same function works identically for a phase bar, the umbrella band,
 * or a visit sub-bar regardless of how many days wide each one happens
 * to be relative to the window. A transform is compositor-only (no
 * layout recalculation on every pointermove), which is what makes this
 * feel smoother than the previous approach of recomputing marginLeft/
 * width directly.
 *
 * "move" slides the whole bar. For "resize-start"/"resize-end" the
 * caller pins `transformOrigin` to the OPPOSITE (non-dragged) edge, so
 * the same translateX reads as "that one edge sliding" while the fixed
 * edge stays put — the bar's actual width is only recomputed once, on
 * commit (see GanttChart.tsx's commitDrag/commitVisitDrag, which call
 * applyDrag — the exact date math this preview must match on release).
 */
export function dragTransform(
  mode: "move" | "resize-start" | "resize-end" | null,
  deltaDays: number,
  winDays: number,
  barWidthPct: number
): string {
  if (!mode || !winDays || !barWidthPct) return "none";
  const deltaPctOfWindow = (deltaDays / winDays) * 100;
  const deltaPctOfBar = (deltaPctOfWindow / barWidthPct) * 100;
  return `translateX(${deltaPctOfBar}%)`;
}

// ------------------------------------------------------------
// Date display formatting — BUILD-SPEC item 6: "left-column ranges
// render '22 Jul → 25 Jul' not raw ISO." Shared by GanttChart.tsx's
// phase-name column, edit panels, and (optionally) anywhere else in
// this round's touched files that shows a raw ISO range.
// ------------------------------------------------------------

/** "22 Jul" — en-AU short day+month, no year (matches this file's own formatWindowRange convention: year is only ever shown when it isn't the obvious current context). */
export function formatShortDateAU(dateStr: string): string {
  return parseDate(dateStr).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** "22 Jul → 25 Jul" — the exact display format item 6 asks for. */
export function formatDateRangeAU(startDate: string, endDate: string): string {
  return `${formatShortDateAU(startDate)} → ${formatShortDateAU(endDate)}`;
}
