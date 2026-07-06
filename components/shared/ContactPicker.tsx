"use client";

import { useEffect, useRef, useState } from "react";
import type { ContactPickerOption, ContactPickerProps } from "@/types/board-cockpit";

/**
 * Shared searchable contact picker — Board cockpit round (7 July 2026)
 * chat-agreed improvement: "shared searchable ContactPicker replacing
 * existing pickers." Generalises the exact interaction shape every
 * ad-hoc contact picker in this codebase had already converged on
 * independently (components/items/SupplierContactPicker.tsx, the
 * inline picker in components/board/ProjectBoard.tsx's BoardCard, and
 * components/gantt/GanttChart.tsx's PhaseEditPanel contact select) —
 * button trigger showing the current selection -> dropdown panel with
 * a search box -> "No link" clear option -> list of matches, now with
 * full keyboard nav (ArrowUp/ArrowDown moves a highlighted row, Enter
 * selects it — or the top match if nothing's been arrow-key-touched
 * yet — Escape closes).
 *
 * FETCH-STRATEGY DECISION (this round, resolving an explicit open
 * question in the task brief): this component does NOT fetch
 * /api/contacts?q= itself — it stays purely presentational +
 * client-side-filtering, handed an already-fetched `contacts` array by
 * its caller. Reasoning: GET /api/contacts has no project scoping and
 * this studio's real contact count is small (that route's own doc
 * comment: "nowhere near 500" — DEFAULT_LIMIT/MAX_LIMIT exist for
 * future-proofing, not because today's dataset needs them) — fetching
 * the full list ONCE per picker-open and filtering client-side is
 * simpler, has zero debounce-timing edge cases, and avoids every call
 * site duplicating its own debounced-fetch effect for what is, at
 * today's scale, a small in-memory array. If the contact count ever
 * grows enough that this stops being cheap, the fix is additive: add
 * an optional `onQueryChange`/`loading` prop pair here so a caller CAN
 * opt into server-side filtering without changing this component's
 * default (fetch-once, filter-client-side) behaviour for everyone
 * else. Every call site below fetches its own `contacts` array ONCE
 * (on mount or on first open, per that call site's own existing
 * pattern) and hands it to this component — none of them re-fetch on
 * every keystroke.
 *
 * Call sites (all four wired this round): components/board/
 * ProjectBoard.tsx's BoardCard/BoardTaskEditorBody (board card editor,
 * both kanban and grouped-list — see that file's shared editor
 * refactor), components/board/BookVisitPanel.tsx (book-trade-from-
 * card), components/gantt/GanttChart.tsx's PhaseEditPanel (phase-level
 * contact field) AND its AddVisitForm (the Timeline's own booking
 * form — previously a plain <select>, now this picker), components/
 * estimate/ContactLinkPicker.tsx (now a thin wrapper delegating here),
 * and components/items/SupplierContactPicker.tsx (now wraps this
 * component internally while KEEPING its existing autofill side-effect
 * — see that file's own updated doc comment). components/items/
 * SpecRegister.tsx itself (protected, consumes SupplierContactPicker)
 * is untouched — only SupplierContactPicker's internals changed.
 */
export function ContactPicker({
  contacts,
  selectedId,
  onSelect,
  placeholder = "Link contact",
  clearable = true,
  embedded = false,
  onClose,
}: ContactPickerProps) {
  // Board cockpit round — `embedded` mode has no trigger button and is
  // always "open"; this local `open` state is simply unused in that
  // mode (the JSX below branches on `embedded` directly rather than
  // reading `open` in that branch) but is kept as a single piece of
  // state either way to avoid two near-duplicate component bodies.
  const [open, setOpen] = useState(false);
  const isOpen = embedded || open;
  function closePanel() {
    if (embedded) {
      onClose?.();
    } else {
      setOpen(false);
    }
  }
  const [q, setQ] = useState("");
  // Board cockpit round — keyboard nav ("keyboard navigable" per this
  // round's brief, item 6): -1 means nothing highlighted yet (the
  // initial state whenever the panel opens or the query changes — a
  // fresh filter shouldn't keep a stale highlighted index pointing at
  // a since-filtered-out row). Index is into the COMBINED list the
  // panel actually renders — the "No link" row (if clearable) at index
  // 0, then `filtered` contacts after it — so Up/Down/Enter operate on
  // exactly what's on screen, never a hidden numbering scheme.
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) setQ("");
  }, [isOpen]);

  useEffect(() => {
    setHighlighted(-1);
  }, [q, isOpen]);

  const selected = contacts.find((c) => c.id === selectedId) ?? null;

  const filtered = q.trim()
    ? contacts.filter((c) => {
        const needle = q.trim().toLowerCase();
        return (
          c.company.toLowerCase().includes(needle) ||
          (c.contact_name ?? "").toLowerCase().includes(needle) ||
          (c.trade_type ?? "").toLowerCase().includes(needle)
        );
      })
    : contacts;

  // Board cockpit round — the same combined "No link" + filtered-
  // contacts list the JSX below renders, so ArrowDown/ArrowUp/Enter
  // walk EXACTLY the visible rows in EXACTLY their visible order.
  const rows: (ContactPickerOption | null)[] = clearable ? [null, ...filtered] : filtered;

  function pick(contact: ContactPickerOption | null) {
    onSelect(contact ? contact.id : null);
    closePanel();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((cur) => Math.min(rows.length - 1, cur + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((cur) => Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0 && highlighted < rows.length) {
        pick(rows[highlighted]);
      } else if (rows.length > 0) {
        // No row explicitly highlighted yet (user typed and hit Enter
        // immediately) — same "Enter selects the top match" affordance
        // most searchable pickers have, rather than requiring an
        // explicit ArrowDown first.
        pick(rows[0]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
    }
  }

  // Board cockpit round — the search box + filtered list is IDENTICAL
  // markup/behaviour in both modes (this is the actual "delegate, not
  // duplicate" body ContactLinkPicker.tsx now reuses via `embedded`) —
  // only the OUTER wrapper (button+popover vs. an always-visible
  // panel with its own header) differs below.
  const searchAndList = (
    <>
      <input
        ref={inputRef}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search company, name, trade…"
        className="w-full border border-[#c9c2b4] bg-cream px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
      />
      <div className="max-h-48 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-caption text-charcoal/50">No contacts match.</p>
        ) : (
          rows.map((c, i) => (
            <button
              key={c ? c.id : "__no_link__"}
              type="button"
              onClick={() => pick(c)}
              onMouseEnter={() => setHighlighted(i)}
              className={
                "block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body last:border-b-0 hover:bg-cream " +
                (i === highlighted
                  ? "bg-cream text-nearblack"
                  : c
                    ? selectedId === c.id
                      ? "bg-cream text-nearblack"
                      : "text-charcoal"
                    : "text-charcoal/60")
              }
            >
              {c ? (
                <>
                  {c.company}
                  {c.contact_name ? ` — ${c.contact_name}` : ""}
                </>
              ) : (
                "No link"
              )}
            </button>
          ))
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="max-w-xl space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="label-caps">Link a contact</p>
          <button type="button" onClick={closePanel} className="text-caption text-charcoal/50 hover:text-nearblack">
            Close
          </button>
        </div>
        {searchAndList}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal hover:border-nearblack"
      >
        {selected ? selected.company : placeholder}
      </button>
      {isOpen && (
        <div className="absolute left-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-2 border border-[#dcd6cc] bg-nearwhite p-3 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="label-caps">Link a contact</p>
            <button type="button" onClick={closePanel} className="text-caption text-charcoal/50 hover:text-nearblack">
              Close
            </button>
          </div>
          {searchAndList}
        </div>
      )}
    </div>
  );
}
