"use client";

import { useEffect, useState } from "react";
import type { Item } from "@/types";

interface Props {
  projectId: string;
  currentItemId: string | null;
  onSelect: (itemId: string | null) => void;
  onClose: () => void;
}

/**
 * Simple select dialog listing the project's spec-register items, so a
 * cost/variation/measurement line can be tied to a register item (e.g.
 * tapware supply lines) — BUILD-SPEC.md "link icon on a line when
 * item_id set (simple select dialog listing project items to link —
 * GET items via existing /api/projects/[id]/items route)".
 *
 * Reuses the existing Spec-register items endpoint rather than adding
 * a new one — that route is outside this feature's file boundary, so
 * this component only ever reads from it (GET), never writes.
 */
export function ItemLinkPicker({ projectId, currentItemId, onSelect, onClose }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/projects/${projectId}/items`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setItems(body.items ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const term = q.trim().toLowerCase();
  const filtered = term
    ? items.filter((it) =>
        [it.name, it.item_code, it.location].filter(Boolean).some((v) => (v as string).toLowerCase().includes(term))
      )
    : items;

  return (
    <div className="max-w-xl space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="label-caps">Link to a spec register item</p>
        <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
          Close
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search item code, name, location…"
        className="w-full border border-[#c9c2b4] bg-cream px-3 py-1.5 text-body focus:border-nearblack focus:outline-none"
      />
      {loading ? (
        <p className="text-caption text-charcoal/50">Loading items…</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body text-charcoal/60 hover:bg-cream"
          >
            No link
          </button>
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-caption text-charcoal/50">No items match.</p>
          ) : (
            filtered.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => onSelect(it.id)}
                className={
                  "flex w-full items-center justify-between gap-3 border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body hover:bg-cream " +
                  (currentItemId === it.id ? "bg-cream text-nearblack" : "text-charcoal")
                }
              >
                <span>
                  {it.item_code} — {it.name}
                </span>
                {it.location && <span className="text-caption text-charcoal/40">{it.location}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
