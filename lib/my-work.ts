// ============================================================
// RESLU Spec System — My Work shared math (Phase 12a-B)
// Pure, dependency-free helpers used by both GET /api/my-work and any
// UI that needs to re-derive a bucket client-side — mirrors
// lib/leads.ts's and lib/trade-visits.ts's established shape (plain
// data in, plain data out, no Supabase/Next imports) so bucketing can
// never drift between server and client.
//
// BUILD-SPEC.md "Phase 12a — My Work": "today / this week / overdue
// groupings". This task's brief adds a fourth bucket, "No date", for
// items with nothing to sort by (per the brief's explicit
// "Today / This week / Overdue / No date across ...").
// ============================================================

import type { MyWorkGroups, MyWorkItem } from "@/types/phase-12a-b";
import { compareDueTimeOnly, isOverdueByDateTime } from "@/lib/time-format";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * Which bucket a `due` value falls into, relative to `now`:
 *   - null/undefined -> "no_date"
 *   - strictly before today -> "overdue"
 *   - today -> "today", UNLESS `dueTime` is set and has already passed
 *     (migration 041, "Small pair" item 2: "overdue turns red by
 *     datetime when time present, else by date") — a same-day item
 *     whose due_time has passed moves into "overdue" (the bucket this
 *     feed already renders in red), rather than sitting quietly in
 *     "today" until midnight the way a date-only due item does.
 *   - after today but within the next 7 days (inclusive) -> "this_week"
 *   - anything further out also lands in "this_week" per the spec's
 *     four-bucket model having no separate "later" bucket — a due date
 *     more than a week away is rare in practice for this feed's source
 *     kinds (board tasks/leads/diary/trade proposals/decisions are all
 *     short-horizon by nature) and still needs a bucket to render in;
 *     "this week" is the closest true bucket rather than inventing a
 *     fifth the spec never asked for.
 */
export function bucketFor(due: string | null, now: Date = new Date(), dueTime?: string | null): keyof MyWorkGroups {
  if (!due) return "no_date";
  const today = startOfDay(now);
  const dueDate = startOfDay(new Date(due.length <= 10 ? `${due}T00:00:00` : due));
  const diffDays = Math.round((dueDate.getTime() - today.getTime()) / DAY_MS);
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) {
    // Date-only `due` here is already a plain yyyy-mm-dd (every source
    // that ever sets dueTime — board/office/design tasks — carries a
    // date-only due, never a full timestamp), so isOverdueByDateTime
    // can compare it directly against `due` itself.
    if (dueTime && isOverdueByDateTime(due.length <= 10 ? due : due.slice(0, 10), dueTime, now)) return "overdue";
    return "today";
  }
  return "this_week";
}

/**
 * Groups a flat MyWorkItem[] into the four buckets, sorted within each
 * bucket by due date ascending (nulls last), with a same-date
 * secondary sort by due_time ascending — BUILD-SPEC.md "Small pair"
 * item 2: "My Work sorts same-day items by time" — items with no
 * due_time on a shared date sort after every timed item that same day
 * (see lib/time-format.ts's compareDueTimeOnly doc comment), falling
 * back to title for a fully deterministic order when dates AND times
 * both tie (or both are absent).
 */
export function groupMyWorkItems(items: MyWorkItem[], now: Date = new Date()): MyWorkGroups {
  const groups: MyWorkGroups = { overdue: [], today: [], this_week: [], no_date: [] };
  for (const item of items) {
    groups[bucketFor(item.due, now, item.due_time)].push(item);
  }
  for (const key of Object.keys(groups) as (keyof MyWorkGroups)[]) {
    groups[key].sort((a, b) => {
      if (a.due && b.due) {
        const byDate = a.due.localeCompare(b.due);
        if (byDate !== 0) return byDate;
        const byTime = compareDueTimeOnly(a.due_time, b.due_time);
        if (byTime !== 0) return byTime;
        return a.title.localeCompare(b.title);
      }
      if (a.due) return -1;
      if (b.due) return 1;
      return a.title.localeCompare(b.title);
    });
  }
  return groups;
}

/** Total item count across all four buckets — convenience for a sidebar badge if one is ever added (not built in this task; kept here so a future one-line addition doesn't need new math). */
export function totalMyWorkCount(groups: MyWorkGroups): number {
  return groups.overdue.length + groups.today.length + groups.this_week.length + groups.no_date.length;
}
