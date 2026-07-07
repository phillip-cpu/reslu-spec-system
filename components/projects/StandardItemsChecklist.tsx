"use client";

import { useEffect, useState } from "react";
import type { LibraryItemWithStandardFlag } from "@/types/round-d";

interface Props {
  /** Selected library item ids — all-ticked-by-default, individually
   * untickable, controlled by the parent form (mirrors every other
   * controlled field in ProjectForm.tsx / LeadDetailPanel.tsx). */
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Compact variant for the leads "Progress to job" confirm step
   * (BUILD-SPEC.md: "keep compact") — smaller type, tighter spacing,
   * no expand/collapse chrome since that panel is already a slide-over
   * with limited room. */
  compact?: boolean;
}

/**
 * "Standard spec items · N" expandable checklist — BUILD-SPEC.md "Two
 * from Phillip — 7 July 2026 (migration 030 round)": Create Project
 * gets an expandable checklist of every library item flagged
 * `is_standard` (GET /api/library?standard=1), all pre-ticked,
 * individually untickable; the same checklist (compact) appears in the
 * leads "Progress to job" confirm step. When no library items are
 * flagged standard, this renders nothing at all (not even the empty
 * "· 0" header) — per spec "when none are standard, UI shows nothing".
 *
 * Selection state lives in the parent (selectedIds/onChange) rather
 * than locally, so the two very different submit flows (ProjectForm's
 * full-page form vs. LeadDetailPanel's confirm button) can each fold
 * `standard_item_ids` into their own POST body at submit time without
 * this component knowing anything about either request shape.
 */
export function StandardItemsChecklist({ selectedIds, onChange, compact = false }: Props) {
  const [items, setItems] = useState<LibraryItemWithStandardFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(!compact);

  useEffect(() => {
    let active = true;
    fetch("/api/library?standard=1")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((body) => {
        if (!active) return;
        const fetched: LibraryItemWithStandardFlag[] = body.items ?? [];
        setItems(fetched);
        // All ticked by default — see doc comment above.
        onChange(fetched.map((i) => i.id));
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // Intentionally runs once on mount only — onChange is a stable
    // setter passed from the parent (same "run once, ignore fn identity"
    // pattern used throughout this codebase for mount-time fetches).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: string) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id]);
  }

  // Per spec: "When none are standard, UI shows nothing" — including
  // while still loading (a flash of an empty checklist header is worse
  // than a brief absence of one).
  if (loading || items.length === 0) return null;

  const labelClass = compact ? "text-caption text-charcoal/50" : "label-caps";

  return (
    <div className={compact ? "border border-[#dcd6cc] p-3" : "border border-[#dcd6cc] p-4"}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={`flex w-full items-center justify-between ${labelClass}`}
      >
        <span>
          Standard spec items · {items.length}
        </span>
        <span className="text-charcoal/40">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <ul className={compact ? "mt-2 space-y-1" : "mt-3 space-y-1.5"}>
          {items.map((item) => (
            <li key={item.id}>
              <label className="flex items-center gap-2 text-body text-charcoal">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={() => toggle(item.id)}
                  className="accent-sand"
                />
                <span className={compact ? "text-caption" : "text-body"}>
                  {item.name}
                  {item.brand ? ` — ${item.brand}` : ""}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
