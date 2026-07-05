"use client";

import { useState } from "react";
import { umbrellaGridPosition } from "@/lib/gantt";
import type { GanttGrid } from "@/lib/gantt";

/**
 * Renders the auto-maintained "Site Setup" umbrella phase as a
 * full-width band row — visually distinct from ordinary phase rows
 * (a hatched/dashed treatment rather than a solid bar, since it
 * represents a system-derived summary, not a team-editable phase).
 * Read-only informational panel on tap: lists the linked
 * "Preliminaries & Site" cost section's line DESCRIPTIONS only (no
 * cost/pricing fields) — see GET /api/projects/[id]/phases's
 * `cost_section_lines` field.
 */
export function UmbrellaBand({
  name,
  startDate,
  endDate,
  grid,
  costSectionLines,
}: {
  name: string;
  startDate: string;
  endDate: string;
  grid: GanttGrid;
  costSectionLines: string[];
}) {
  const [open, setOpen] = useState(false);
  const pos = umbrellaGridPosition({ start_date: startDate, end_date: endDate }, grid);

  return (
    <>
      <div className="col-start-1 border-b border-r border-[#e5e0d6] bg-cream/60 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-left text-body text-charcoal/70 hover:text-sand"
        >
          {name}
        </button>
        <p className="text-caption text-charcoal/40">Whole-of-job preliminaries</p>
      </div>
      <div
        className="relative border-b border-[#e5e0d6] py-2"
        style={{ gridColumn: `2 / span ${grid.weekCount}` }}
      >
        <div
          className="h-4 border border-dashed border-charcoal/40 bg-charcoal/10"
          style={{
            marginLeft: `calc((100% / ${grid.weekCount}) * ${pos.startCol - 1})`,
            width: `calc((100% / ${grid.weekCount}) * ${pos.span})`,
          }}
          title={`${name}: ${startDate} to ${endDate} (auto-spans the whole schedule)`}
        />
      </div>

      {open && (
        <div className="col-span-full border-b border-[#dcd6cc] bg-offwhite px-3 py-3">
          <p className="label-caps mb-2">Preliminaries & Site</p>
          {costSectionLines.length === 0 ? (
            <p className="text-body text-charcoal/50">No line items yet.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-4">
              {costSectionLines.map((line, i) => (
                <li key={i} className="text-body text-charcoal">
                  {line}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-caption text-charcoal/40">
            This band is system-managed — its dates track the full span of every other phase
            automatically and cannot be edited directly.
          </p>
        </div>
      )}
    </>
  );
}
