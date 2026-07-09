"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { formatTime12h } from "@/lib/time-format";

/**
 * Bug fix, 8 July 2026: was `toLocaleDateString("en-AU", { month:
 * "short" })` — a genuine React hydration mismatch, confirmed by
 * reproducing it with a non-minified error: the SAME date, SAME
 * locale, SAME options rendered "9 July" on the server (Node's bundled
 * ICU data for en-AU) but "9 Jul" on the client (Safari/WebKit's own
 * ICU data for en-AU) — a cross-engine Intl/ICU data discrepancy, not
 * a timezone issue (this is a DIFFERENT bug class from isPastDue's
 * fix above/nearby). `toLocaleDateString` can silently disagree
 * between the Node runtime that renders the initial HTML and whatever
 * browser hydrates it, for ANY locale/option combination — there is no
 * "correct" fix that still delegates to Intl here. A manual, hardcoded
 * month-abbreviation array has zero locale/ICU dependency, so server
 * and client can never produce different text for the same date,
 * regardless of engine or Intl data version.
 */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

/**
 * Board v3.1 — display-first cells, item 2 "Works/due dates
 * display-first": DUE cell. Quiet text chip when not editing ("14
 * Jul", or "—" when unset — still clickable to add one); click swaps
 * to a real `<input type="date">`, autofocused. Blur or Enter commits
 * via the SAME onCommit callback the caller already used for due_date
 * (GroupRows' existing inline `<input type="date">` PATCH path,
 * components/board/ProjectBoard.tsx) — this component only changes
 * WHEN the input is visible, never how the write happens. Esc cancels
 * and reverts to the display chip without committing.
 *
 * Overdue rendering: red text when `pastDue` is true — `pastDue` is
 * computed by the caller (GroupRows already has this exact check,
 * migration 041-updated to lib/time-format.ts's isOverdueByDateTime()
 * so it turns red by full datetime once a due_time is set, else by
 * date alone, per BUILD-SPEC.md "Small pair" item 2) and simply passed
 * through here as a boolean, so this component stays free of "what
 * counts as done"/"what counts as overdue" business logic.
 *
 * migration 041 ("Small pair" item 2): gains an optional TIME input
 * alongside the date one, inside the same click-to-reveal popover —
 * same two-field popover shape as this file's own WorksDateCell below
 * (Start/End), just Date/Time instead. The time input is disabled
 * whenever the date draft is empty (a time with no date is meaningless
 * — clearing the date also clears any drafted time). Commits BOTH
 * fields as a single `{ due_date, due_time }` pair via `onCommit` (not
 * two separate PATCHes), mirroring WorksDateCell's own "commit once as
 * a pair" discipline so the two values are never transiently
 * inconsistent mid-edit.
 */
export function DueDateCell({
  value,
  timeValue,
  pastDue,
  onCommit,
}: {
  value: string | null;
  /** Optional wall-clock reminder time, "HH:MM" or "HH:MM:SS" (Postgres `time`) — null/undefined when unset. */
  timeValue?: string | null;
  pastDue: boolean;
  onCommit: (next: { due_date: string | null; due_time: string | null }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState(value ?? "");
  const [draftTime, setDraftTime] = useState(timeValue ?? "");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraftDate(value ?? "");
      setDraftTime(timeValue ?? "");
    }
  }, [editing, value, timeValue]);

  useEffect(() => {
    if (!editing) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        commit();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draftDate, draftTime]);

  function commit() {
    setEditing(false);
    const nextDate = draftDate || null;
    const nextTime = nextDate ? draftTime || null : null;
    if (nextDate !== value || nextTime !== (timeValue ?? null)) {
      onCommit({ due_date: nextDate, due_time: nextTime });
    }
  }

  function cancel() {
    setDraftDate(value ?? "");
    setDraftTime(timeValue ?? "");
    setEditing(false);
  }

  if (editing) {
    return (
      <div ref={wrapperRef} className="relative inline-block">
        <div className="absolute left-0 top-full z-30 mt-1 flex items-center gap-1.5 border border-[#dcd6cc] bg-nearwhite p-2 shadow-sm">
          <input
            ref={dateInputRef}
            autoFocus
            type="date"
            value={draftDate}
            onChange={(e) => {
              const v = e.target.value;
              setDraftDate(v);
              if (!v) setDraftTime(""); // no date -> a drafted time is meaningless, clear it too
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") cancel();
            }}
            className={clsx(
              "w-32 border bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none",
              pastDue ? "border-red-700/40 text-red-700" : "border-[#c9c2b4] text-charcoal/60"
            )}
          />
          <input
            type="time"
            value={draftTime}
            disabled={!draftDate}
            onChange={(e) => setDraftTime(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") cancel();
            }}
            title={draftDate ? "Optional reminder time" : "Set a date first"}
            className="w-24 border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption text-charcoal/60 focus:border-nearblack focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to set due date/time"
      className={clsx("px-1 py-0.5 text-caption hover:opacity-70", pastDue ? "text-red-700" : "text-charcoal/60")}
    >
      {value ? `${formatShort(value)}${timeValue ? ` · ${formatTime12h(timeValue)}` : ""}` : "—"}
    </button>
  );
}

/**
 * Board v3.1 — display-first cells, item 2: WORKS cell display chip —
 * "8 Jul" (single day, start === end or no end) or "8–16 Jul" (en-dash;
 * short day-month; the END date drops its OWN month label when it's
 * the SAME month as the start, e.g. "8–16 Jul" rather than "8 Jul–16
 * Jul", falling back to repeating both full "D Mon" labels whenever the
 * range crosses a month boundary, e.g. "28 Jun–3 Jul" — never a
 * fabricated shorthand for a cross-month span). Exported (not just used
 * internally by WorksDateCell below) so the popover's own trigger and
 * any other read-only display site can share the exact same formatting
 * rules without copy-pasting them.
 */
export function formatWorksDateRange(startDate: string, endDate: string | null): string {
  const startDt = new Date(startDate + "T00:00:00");
  const hasRange = !!endDate && endDate !== startDate;
  if (!hasRange) return formatShort(startDate);
  const endDt = new Date(endDate + "T00:00:00");
  const sameMonth = startDt.getMonth() === endDt.getMonth() && startDt.getFullYear() === endDt.getFullYear();
  if (sameMonth) {
    // Bug fix, 8 July 2026: same Intl/ICU cross-engine reasoning as
    // formatShort above — a bare day number is very unlikely to differ,
    // but there's no upside to routing it through Intl at all here.
    return `${startDt.getDate()}–${formatShort(endDate)}`;
  }
  return `${formatShort(startDate)}–${formatShort(endDate)}`;
}

/**
 * Board v3.3 — "placeholder dates + booking actually sends", item 1:
 * WORKS cell REBUILT as a genuine start+end popover, exactly like this
 * file's own DueDateCell above — this REVERSES the v3.1 deviation this
 * component used to document at length right here (see git history /
 * BUILD-SPEC.md's "Board v3.3" section item 1 for the full story): v3.1
 * made this cell open the Book-trade panel because
 * booking_date/booking_end_date weren't independently PATCHable at all;
 * v3.3 puts them back in PATCH /api/board-tasks/[id]'s EDITABLE_FIELDS
 * (see that route's own doc comment), so works dates are now freely
 * editable placeholders exactly like DUE, committing directly via
 * `onCommit` rather than opening any panel.
 *
 * Quiet chip at rest ("8–16 Jul", or "—" when unset); click reveals two
 * `<input type="date">`s (Start/End) in a small popover, autofocused on
 * Start. Enter on either input or a click outside commits; Esc cancels
 * and reverts to the display chip without committing — same discipline
 * as every other click-to-reveal control in this round (DueDateCell,
 * PopoverCell). Commits ONCE, as a single `{ booking_date, booking_end_date }`
 * pair via `onCommit` (not two separate PATCHes), so the route's own
 * start<=end validation always sees a consistent pair rather than a
 * transient invalid intermediate state a two-request sequence could
 * produce.
 *
 * `visitId` (present only when this task has a linked trade_visits row)
 * drives the "also updates the booked visit" hint shown inside the open
 * popover — a plain, non-blocking one-line note (not a warning/error;
 * the sync itself is server-side, this is purely so a click here isn't
 * a surprise for a booked task) that this edit isn't a placeholder-only
 * change, it will also move the actual booking (and flag a re-confirm
 * prompt if that visit is currently 'confirmed' — see PATCH
 * /api/board-tasks/[id]'s WORKS-DATE / VISIT SYNC doc comment). Book
 * trade itself remains a SEPARATE, explicit action (its own button) —
 * this popover only ever edits dates on whatever booking state already
 * exists (including none), never creates or removes the visit link.
 */
export function WorksDateCell({
  startDate,
  endDate,
  visitId,
  visitStatusLabel,
  onCommit,
}: {
  startDate: string | null;
  endDate: string | null;
  /** Present only when this task carries a linked trade_visits row — drives the "also updates the booked visit" hint, see this component's own doc comment. */
  visitId: string | null;
  visitStatusLabel: string | null;
  /** Commits BOTH dates as a single pair — see this component's own doc comment for why this is one call, not two. */
  onCommit: (next: { booking_date: string | null; booking_end_date: string | null }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [startDraft, setStartDraft] = useState(startDate ?? "");
  const [endDraft, setEndDraft] = useState(endDate ?? "");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const startInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setStartDraft(startDate ?? "");
      setEndDraft(endDate ?? "");
    }
  }, [editing, startDate, endDate]);

  useEffect(() => {
    if (!editing) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        commit();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, startDraft, endDraft]);

  function commit() {
    setEditing(false);
    const nextStart = startDraft || null;
    const nextEnd = endDraft || null;
    if (nextStart !== startDate || nextEnd !== endDate) {
      onCommit({ booking_date: nextStart, booking_end_date: nextEnd });
    }
  }

  function cancel() {
    setStartDraft(startDate ?? "");
    setEndDraft(endDate ?? "");
    setEditing(false);
  }

  if (editing) {
    return (
      <div ref={wrapperRef} className="relative inline-block">
        <div className="absolute left-0 top-full z-30 mt-1 flex flex-col gap-1.5 border border-[#dcd6cc] bg-nearwhite p-2 shadow-sm">
          <div className="flex items-center gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className="label-caps !text-charcoal/40">Start</span>
              <input
                ref={startInputRef}
                autoFocus
                type="date"
                value={startDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setStartDraft(v);
                  // Phillip 8 Jul: picking a start snaps the end field to
                  // the same date when empty/earlier — no month-flicking.
                  if (v && (!endDraft || endDraft < v)) setEndDraft(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") cancel();
                }}
                className="w-36 border border-[#c9c2b4] bg-cream px-1.5 py-1 text-caption text-charcoal focus:border-nearblack focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="label-caps !text-charcoal/40">End</span>
              <input
                type="date"
                value={endDraft}
                onChange={(e) => setEndDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") cancel();
                }}
                className="w-36 border border-[#c9c2b4] bg-cream px-1.5 py-1 text-caption text-charcoal focus:border-nearblack focus:outline-none"
              />
            </label>
          </div>
          {visitId && (
            <p className="max-w-[15rem] text-caption text-charcoal/50">
              Also updates the booked visit{visitStatusLabel === "Confirmed" ? " — re-confirm may be needed." : "."}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={visitId ? "Booked works window — click to change (also updates the booking)" : "Click to set works dates"}
      className={clsx("px-1 py-0.5 text-caption hover:opacity-70", startDate ? "!text-sand" : "text-charcoal/40")}
    >
      {startDate ? formatWorksDateRange(startDate, endDate) : "—"}
      {startDate && visitStatusLabel ? ` · ${visitStatusLabel}` : ""}
    </button>
  );
}
