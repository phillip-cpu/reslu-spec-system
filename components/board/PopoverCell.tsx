"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Board v3.1 — display-first cells — shared "click to reveal control"
 * wrapper, per this round's brief: a simple shared primitive so the
 * ASSIGNEE and CONTACT grouped-list cells (item 4) don't each hand-roll
 * their own open/close/click-outside/Esc plumbing (StatusPill above
 * already needed the identical open/close/click-outside shape, but is
 * kept as its own component since its trigger is a coloured pill with
 * its own tint styling, not a plain display node — this wrapper is for
 * the two cells that DON'T need that, so it stays a thin, generic
 * primitive rather than something StatusPill is refactored to sit
 * inside, avoiding a bigger diff than this round needs).
 *
 * `trigger` is whatever quiet display node the cell wants to show at
 * rest (an avatar stack, a contact name, "—", etc.) — this component
 * only owns the popover mechanics: click the trigger to open, Esc or
 * a click outside the popover closes it. The popover's CONTENTS
 * (`children`) are rendered via a render-prop so they can call
 * `close()` themselves once a selection is made (e.g. AssigneeStack's
 * picker closes on each checkbox toggle... actually most callers close
 * on explicit "Done"/selection, per their own contents).
 */
export function PopoverCell({
  trigger,
  triggerTitle,
  onOpen,
  children,
}: {
  trigger: React.ReactNode;
  triggerTitle?: string;
  /** Optional — fired the moment the popover transitions from closed to open (never on re-render while already open). Lets a caller lazily fetch data the popover's contents need (e.g. GroupRows' CONTACT cell fetching /api/contacts on first open) without fetching on every mount. */
  onOpen?: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() =>
          setOpen((o) => {
            const next = !o;
            if (next) onOpen?.();
            return next;
          })
        }
        title={triggerTitle}
        className="px-1 py-0.5 text-left hover:opacity-70"
      >
        {trigger}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 border border-[#dcd6cc] bg-nearwhite p-2 shadow-sm">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
