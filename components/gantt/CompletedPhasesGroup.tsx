"use client";

import { useState } from "react";
import type { SchedulePhaseWithVisits } from "@/lib/trade-visits";

/**
 * Collapses phases whose end_date is before today into a single
 * collapsible summary row, default collapsed — BUILD-SPEC "Completed-
 * phases collapse group". Reduces visual clutter on long-running
 * projects where most historical phases are no longer actionable.
 * Expanding re-renders each completed phase as an ordinary row via
 * the `renderRow` callback, so this component owns only the
 * collapse/expand chrome, not phase-row rendering itself (kept
 * consistent with the rest of the phase row's rendering in
 * GanttChart.tsx rather than duplicating that logic here).
 */
export function CompletedPhasesGroup({
  phases,
  weekCount,
  renderRow,
}: {
  phases: SchedulePhaseWithVisits[];
  weekCount: number;
  renderRow: (phase: SchedulePhaseWithVisits) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  if (phases.length === 0) return null;

  return (
    <>
      <div className="col-start-1 border-b border-r border-[#e5e0d6] bg-cream/40 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="label-caps"
        >
          {expanded ? "▾" : "▸"} Completed ({phases.length})
        </button>
      </div>
      <div
        className="border-b border-[#e5e0d6] bg-cream/40 py-2"
        style={{ gridColumn: `2 / span ${weekCount}` }}
      />
      {expanded && phases.map((phase) => renderRow(phase))}
    </>
  );
}
