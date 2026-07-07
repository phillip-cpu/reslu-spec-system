"use client";

import { useEffect, useRef, useState } from "react";
import type { StatusPillTint } from "@/lib/board-constants";

export interface StatusPillOption {
  id: string;
  name: string;
}

/**
 * Board v3.1 — display-first cells. Replaces the grouped-list's bare
 * native `<select>` status control (the pre-v3.1 StatusPillSelect,
 * components/board/ProjectBoard.tsx) with a QUIET pill in its resting
 * state — no visible chrome beyond the coloured tint — that only
 * becomes an interactive control (a small popover menu of every valid
 * value, rendered as pills) once clicked. Matches the approved
 * "display as quiet text/pills; interactive only on click" mockup
 * principle for this round.
 *
 * Same underlying data contract as the select it replaces: `value` is
 * the current column_id, `onChange` fires with the newly chosen
 * column_id, `tint`/`columnOptions` are passed straight through from
 * the caller exactly as StatusPillSelect already received them — this
 * is a drop-in visual replacement, not a behaviour change. Tap→move
 * (touch) and click→move (mouse) both work via the same popover.
 *
 * Interaction:
 *   - Click/Enter (while focused) opens the popover.
 *   - Esc closes without changing anything.
 *   - Click outside closes without changing anything.
 *   - ArrowDown/ArrowUp move a highlighted option; Enter selects it;
 *     Esc cancels. Same keyboard-nav shape as the shared ContactPicker
 *     (components/shared/ContactPicker.tsx) for consistency across
 *     this round's click-to-edit cells.
 */
export function StatusPill({
  value,
  columnOptions,
  tint,
  onChange,
}: {
  value: string;
  columnOptions: StatusPillOption[];
  tint: StatusPillTint | null;
  onChange: (columnId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const current = columnOptions.find((c) => c.id === value);

  useEffect(() => {
    if (!open) return;
    setHighlighted(columnOptions.findIndex((c) => c.id === value));
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function choose(columnId: string) {
    setOpen(false);
    if (columnId !== value) onChange(columnId);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((cur) => Math.min(columnOptions.length - 1, cur + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((cur) => Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0 && highlighted < columnOptions.length) {
        choose(columnOptions[highlighted].id);
      }
    }
  }

  return (
    <div ref={wrapperRef} className="relative inline-block" onKeyDown={open ? onMenuKeyDown : undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        title="Click to change status"
        className="border px-1.5 py-0.5 text-caption focus:outline-none"
        style={
          tint
            ? { backgroundColor: tint.background, color: tint.text, borderColor: tint.border }
            : { backgroundColor: "transparent", borderColor: "#c9c2b4" }
        }
      >
        {current?.name ?? "—"}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[9rem] border border-[#dcd6cc] bg-nearwhite p-1.5 shadow-sm">
          <div className="flex flex-col gap-1">
            {columnOptions.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => choose(c.id)}
                className={
                  "border px-1.5 py-1 text-left text-caption " +
                  (i === highlighted ? "border-nearblack" : "border-transparent") +
                  (c.id === value ? " font-bold" : "")
                }
                style={{ backgroundColor: "transparent", color: "#313131" }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
