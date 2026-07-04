"use client";

import { useMemo, useState } from "react";
import type { MeasurementWithGroup } from "@/types";

interface Props {
  measurements: MeasurementWithGroup[];
  currentMeasurementId: string | null;
  onSelect: (measurementId: string | null) => void;
  onClose: () => void;
}

/**
 * Link-a-measurement dialog for a cost line — BUILD-SPEC.md
 * "Estimate ↔ Schedule integration": "link icon → picker of
 * measurements (grouped by measurement group)". Mirrors
 * components/estimate/ItemLinkPicker.tsx's shape (same search box +
 * scrollable list + "No link" affordance), grouped by
 * `measurement.group_name` instead of a flat list, since measurements
 * are already organised into named groups (Floor Areas, Tiling Areas,
 * etc.) the user recognises.
 *
 * Receives `measurements` from the parent (already fetched as part of
 * GET /api/projects/[id]/estimate's response) rather than fetching its
 * own — there is no per-measurement-group-scoped list endpoint that
 * returns the flat, group-annotated shape this picker needs, and the
 * data is already in memory one level up.
 */
export function MeasurementLinkPicker({
  measurements,
  currentMeasurementId,
  onSelect,
  onClose,
}: Props) {
  const [q, setQ] = useState("");

  const term = q.trim().toLowerCase();
  const filtered = term
    ? measurements.filter((m) =>
        [m.label, m.group_name].filter(Boolean).some((v) => v.toLowerCase().includes(term))
      )
    : measurements;

  const grouped = useMemo(() => {
    const map = new Map<string, MeasurementWithGroup[]>();
    for (const m of filtered) {
      const key = m.group_name || "Ungrouped";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="max-w-xl space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="label-caps">Link to a measurement</p>
        <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
          Close
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search label or group…"
        className="w-full border border-[#c9c2b4] bg-cream px-3 py-1.5 text-body focus:border-nearblack focus:outline-none"
      />
      <div className="max-h-56 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body text-charcoal/60 hover:bg-cream"
        >
          No link
        </button>
        {grouped.length === 0 ? (
          <p className="px-2 py-2 text-caption text-charcoal/50">
            {measurements.length === 0
              ? "No measurements yet — add some in the Areas & Measurements tab."
              : "No measurements match."}
          </p>
        ) : (
          grouped.map(([groupName, rows]) => (
            <div key={groupName}>
              <p className="label-caps mt-2 px-2 !text-sand">{groupName}</p>
              {rows.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onSelect(m.id)}
                  className={
                    "flex w-full items-center justify-between gap-3 border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body hover:bg-cream " +
                    (currentMeasurementId === m.id ? "bg-cream text-nearblack" : "text-charcoal")
                  }
                >
                  <span>{m.label}</span>
                  <span className="text-caption text-charcoal/40">
                    {m.value} {m.unit}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
