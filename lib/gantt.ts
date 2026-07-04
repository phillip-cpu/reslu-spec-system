// ============================================================
// RESLU Spec System — Gantt grid math
// Pure, dependency-free helpers shared by the internal Timeline tab
// (components/gantt/GanttChart.tsx) and, in spirit, the read-only
// portal mirror (components/portal/TimelineSection.tsx uses its own
// minimal inline version of the week-span math since it only needs
// bar position, not the full internal editing UI — see that file).
//
// BUILD-SPEC.md "Gantt": "CSS-grid gantt — left column phase names,
// columns = weeks spanning min(start) to max(end) (cap 52; month
// labels header), bars positioned by grid-column start/span".
// ============================================================

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = MS_PER_DAY * 7;
const MAX_WEEKS = 52;

export interface PhaseDateRange {
  start_date: string;
  end_date: string;
}

/** Monday-aligned start of the week containing `date` (UTC-safe, date-only arithmetic). */
function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function parseDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

export interface GanttGrid {
  /** The Monday-aligned start of the first week column. */
  gridStart: Date;
  /** Total number of week columns, capped at MAX_WEEKS. */
  weekCount: number;
  /** One entry per week column — its Monday date, for the header. */
  weeks: Date[];
}

/**
 * Computes the shared week-grid spanning every phase's min(start_date)
 * to max(end_date), capped at 52 columns per BUILD-SPEC.md. If the
 * true span exceeds 52 weeks, the grid is capped at 52 from
 * gridStart — phases (or parts of phases) beyond week 52 simply won't
 * have a column to render into; the caller is expected to clip a
 * phase's rendered span to the grid (see phaseGridPosition below,
 * which already clamps span into [1, weekCount - startCol]).
 */
export function computeGanttGrid(phases: PhaseDateRange[]): GanttGrid {
  if (phases.length === 0) {
    const today = startOfWeek(new Date());
    return { gridStart: today, weekCount: 1, weeks: [today] };
  }

  const starts = phases.map((p) => parseDate(p.start_date).getTime());
  const ends = phases.map((p) => parseDate(p.end_date).getTime());
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);

  const gridStart = startOfWeek(new Date(minStart));
  const spanWeeks = Math.max(
    1,
    Math.ceil((maxEnd - gridStart.getTime()) / MS_PER_WEEK)
  );
  const weekCount = Math.min(spanWeeks, MAX_WEEKS);

  const weeks: Date[] = [];
  for (let i = 0; i < weekCount; i++) {
    weeks.push(new Date(gridStart.getTime() + i * MS_PER_WEEK));
  }

  return { gridStart, weekCount, weeks };
}

export interface GridPosition {
  /** 1-based CSS grid-column start (relative to the first week column). */
  startCol: number;
  /** Number of columns the bar spans, clamped to stay within the grid. */
  span: number;
}

/**
 * Maps a phase's date range onto the shared week grid — BUILD-SPEC.md
 * "bars positioned by grid-column start/span". A phase starting before
 * gridStart (shouldn't happen since gridStart is derived from the
 * minimum start, but defensive) clamps to column 1. A phase extending
 * past the grid's last week clamps its span so it never renders a
 * grid-column value beyond weekCount.
 */
export function phaseGridPosition(phase: PhaseDateRange, grid: GanttGrid): GridPosition {
  const start = parseDate(phase.start_date).getTime();
  const end = parseDate(phase.end_date).getTime();

  const startWeekOffset = Math.floor((start - grid.gridStart.getTime()) / MS_PER_WEEK);
  const endWeekOffset = Math.floor((end - grid.gridStart.getTime()) / MS_PER_WEEK);

  const startCol = Math.max(1, startWeekOffset + 1);
  const rawSpan = Math.max(1, endWeekOffset - startWeekOffset + 1);
  const span = Math.min(rawSpan, grid.weekCount - startCol + 1);

  return { startCol, span: Math.max(1, span) };
}

/** Month label for a week's Monday date, shown once per month change in the header row. */
export function monthLabel(weekStart: Date): string {
  return weekStart.toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
}

/** True if this week starts a new calendar month relative to the previous week in the array. */
export function isNewMonth(weeks: Date[], index: number): boolean {
  if (index === 0) return true;
  const prev = weeks[index - 1];
  const cur = weeks[index];
  return prev.getUTCMonth() !== cur.getUTCMonth() || prev.getUTCFullYear() !== cur.getUTCFullYear();
}
