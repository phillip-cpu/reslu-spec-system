"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** "14 Jul" — short day-month, en-AU locale, matching this codebase's existing formatShortDate() (components/board/ProjectBoard.tsx) exactly so both display the identical format. */
function formatShort(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" });
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
 * Overdue rendering: red text when `pastDue` is true (due date < today
 * AND task not done) — `pastDue` is computed by the caller (GroupRows
 * already has this exact isPastDue() check) and simply passed through
 * here as a boolean, so this component stays free of "what counts as
 * done" business logic.
 */
export function DueDateCell({
  value,
  pastDue,
  onCommit,
}: {
  value: string | null;
  pastDue: boolean;
  onCommit: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) setDraft(value ?? "");
  }, [editing, value]);

  function commit() {
    setEditing(false);
    const next = draft || null;
    if (next !== value) onCommit(next);
  }

  function cancel() {
    setDraft(value ?? "");
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") cancel();
        }}
        className={clsx(
          "border bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none",
          pastDue ? "border-red-700/40 text-red-700" : "border-[#c9c2b4] text-charcoal/60"
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to set due date"
      className={clsx("px-1 py-0.5 text-caption hover:opacity-70", pastDue ? "text-red-700" : "text-charcoal/60")}
    >
      {value ? formatShort(value) : "—"}
    </button>
  );
}

/**
 * Board v3.1 — display-first cells, item 2: WORKS cell. Quiet display
 * chip only — "8 Jul" (single day, start === end or no end) or "8–16
 * Jul" (en-dash; short day-month; the END date drops its OWN month
 * label when it's the SAME month as the start, e.g. "8–16 Jul" rather
 * than "8 Jul–16 Jul", falling back to repeating both full "D Mon"
 * labels whenever the range crosses a month boundary, e.g. "28 Jun–3
 * Jul" — never a fabricated shorthand for a cross-month span).
 *
 * DELIBERATELY READ-ONLY, never an editable date input: booking_date/
 * booking_end_date are NOT independently PATCHable anywhere in this
 * codebase (app/api/board-tasks/[id]/route.ts's EDITABLE_FIELDS
 * whitelist explicitly excludes them; migration 029's own column
 * comment: "only ever written via POST/DELETE .../book-visit" — a
 * single, auditable write path so a booking's dates can never desync
 * from its linked trade_visits row). Clicking this chip therefore
 * opens the SAME "Book trade" flow every other works-date affordance
 * in this file already uses (`onOpenBookVisit`) rather than swapping
 * in a raw date input the PATCH route would reject anyway — this is
 * the one cell in this round's "click reveals an input" set that
 * click-reveals a PANEL instead, for that reason.
 */
export function WorksDateCell({
  startDate,
  endDate,
  visitStatusLabel,
  onOpenBookVisit,
}: {
  startDate: string | null;
  endDate: string | null;
  visitStatusLabel: string | null;
  onOpenBookVisit: () => void;
}) {
  if (!startDate) {
    return (
      <button
        type="button"
        onClick={onOpenBookVisit}
        title="Click to book a trade visit"
        className="px-1 py-0.5 text-caption text-charcoal/40 hover:text-nearblack"
      >
        —
      </button>
    );
  }

  const startDt = new Date(startDate + "T00:00:00");
  const hasRange = !!endDate && endDate !== startDate;
  let label: string;
  if (!hasRange) {
    label = formatShort(startDate);
  } else {
    const endDt = new Date(endDate + "T00:00:00");
    const sameMonth = startDt.getMonth() === endDt.getMonth() && startDt.getFullYear() === endDt.getFullYear();
    if (sameMonth) {
      const startDay = startDt.toLocaleDateString("en-AU", { day: "numeric" });
      label = `${startDay}–${formatShort(endDate)}`;
    } else {
      label = `${formatShort(startDate)}–${formatShort(endDate)}`;
    }
  }

  return (
    <button
      type="button"
      onClick={onOpenBookVisit}
      title="Booked works window — click to view/change the booking"
      className="px-1 py-0.5 text-caption !text-sand hover:opacity-70"
    >
      {label}
      {visitStatusLabel ? ` · ${visitStatusLabel}` : ""}
    </button>
  );
}
