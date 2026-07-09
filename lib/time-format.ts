// ============================================================
// RESLU Spec System — due_time shared helpers ("Small pair", 8 July
// 2026, item 2 / migration 041). Pure, dependency-free — no Supabase/
// Next imports, plain data in/out — mirroring lib/order-by.ts /
// lib/board-cockpit.ts's exact shape so this feature's time-of-day
// formatting and overdue-by-datetime rule can never drift between
// components/board/DateCell.tsx, components/office/OfficeBoard.tsx,
// components/projects/design/DesignPhaseSection.tsx, and
// components/my-work/MyWorkWorkspace.tsx.
//
// due_time is a plain Postgres `time` column (no timezone) — always a
// wall-clock "HH:MM:SS" or "HH:MM" string over the wire (supabase-js
// serialises a `time` column this way), paired with an existing
// date-only `due_date` column on the SAME row. This module never
// touches due_date's own date math (see lib/order-by.ts /
// lib/board-cockpit.ts for that) — it only formats/compares the time
// half and decides date-vs-datetime overdue precedence.
// ============================================================

/**
 * Formats a "HH:MM" or "HH:MM:SS" time-only string as a compact 12-hour
 * label with no space before am/pm — BUILD-SPEC.md's own worked
 * example, "2:30pm". Minutes are always shown (even ":00", e.g.
 * "9:00am") since a bare hour ("9am") reads ambiguously fast in a dense
 * list next to a date chip — this mirrors this codebase's existing
 * "always render minutes" convention for arrival times
 * (components/gantt/VisitBar.tsx's arrival_time formatting). Returns an
 * empty string for a null/empty input so a caller can compose
 * `${formatDueShort(date)} ${formatTime12h(time)}`.trim() without a
 * conditional space.
 */
export function formatTime12h(time: string | null | undefined): string {
  if (!time) return "";
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr);
  const m = Number(mStr ?? "0");
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * Whole-minutes-since-midnight parse of a "HH:MM"/"HH:MM:SS" string —
 * used only for the same-day sort in sortByDueDateTime() below, never
 * exported for date math elsewhere (that stays lib/order-by.ts's/
 * lib/board-cockpit.ts's job).
 */
function minutesOfDay(time: string): number {
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr);
  const m = Number(mStr ?? "0");
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/**
 * Adelaide-anchored "now", as (date, time) STRINGS — deliberately not a
 * `Date` object comparison. Mirrors components/board/ProjectBoard.tsx's
 * own `isPastDue()` fix (8 July 2026): parsing "2026-07-08T14:30:00"
 * with `new Date(...)` interprets it in the RUNTIME's own local
 * timezone, which differs between the Vercel server (UTC) and a
 * browser in Adelaide (UTC+9:30/+10:30) — the exact same server/client
 * hydration-mismatch bug class that fix eliminated for date-only
 * comparisons, except worse for a time-of-day comparison (a due_time of
 * "14:30" must mean 2:30pm ADELAIDE time — this business's timezone —
 * not 2:30pm UTC on the server and 2:30pm Adelaide on the client, two
 * different instants). Explicit `Intl.DateTimeFormat` calls anchored to
 * "Australia/Adelaide" (en-CA for a sortable "YYYY-MM-DD" date string,
 * h23 for a sortable "HH:MM" time string) sidestep Date-object/
 * local-timezone ambiguity entirely, same as isPastDue's own technique
 * — server and client compute the identical strings regardless of
 * which timezone their own clock happens to be in.
 */
function adelaideNowParts(now: Date): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Adelaide",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return { date, time };
}

/**
 * BUILD-SPEC.md "Small pair" item 2: "overdue turns red by datetime
 * when time present, else by date." Given a date-only `dueDate`
 * (yyyy-mm-dd) and optional `dueTime` ("HH:MM[:SS]"), returns whether
 * that due instant has already passed relative to `now`, entirely via
 * string comparison (see adelaideNowParts() above for why):
 *   - no dueDate at all -> never overdue (nothing to compare).
 *   - dueDate is a past calendar day (regardless of dueTime) -> overdue
 *     (a time-of-day on an already-past date can't rescue it).
 *   - dueDate is today AND dueTime is set -> overdue once the current
 *     Adelaide time-of-day has passed dueTime (a 5pm-due task is NOT
 *     overdue at 9am the same day, unlike the date-only rule below).
 *   - dueDate is today with no dueTime, or dueDate is in the future ->
 *     not overdue.
 *   - dueTime absent entirely -> falls back to the EXISTING date-only
 *     rule (strictly before today's calendar date) — unchanged
 *     behaviour for every task that has never set a due_time, per the
 *     spec's "else by date" clause.
 */
export function isOverdueByDateTime(
  dueDate: string | null,
  dueTime: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!dueDate) return false;
  const { date: today, time: nowTime } = adelaideNowParts(now);
  if (dueDate !== today) return dueDate < today;
  if (!dueTime) return false; // due today, no time set -> not overdue until the date itself rolls over
  const normalizedDueTime = dueTime.length >= 5 ? dueTime.slice(0, 5) : dueTime;
  return normalizedDueTime < nowTime;
}

/**
 * Comparator for "same-day items sort by time" (BUILD-SPEC.md "My Work
 * sorts same-day items by time") — items with a due_time sort earlier
 * within the same calendar date; items with no due_time on that same
 * date sort AFTER every timed item (a bare date with no time is
 * treated as "sometime that day", least specific, so it naturally
 * falls to the end of that day's timed items rather than an arbitrary
 * position). Callers are expected to have already grouped/sorted by
 * due_date itself (or bucket, per lib/my-work.ts's groupMyWorkItems) —
 * this comparator only breaks same-date ties; it does not compare
 * across different dates (pass items already confirmed to share the
 * same due_date, or use compareDueDateTime below for a combined
 * date-then-time comparator).
 */
export function compareDueTimeOnly(aTime: string | null | undefined, bTime: string | null | undefined): number {
  if (aTime && bTime) return minutesOfDay(aTime) - minutesOfDay(bTime);
  if (aTime) return -1;
  if (bTime) return 1;
  return 0;
}
