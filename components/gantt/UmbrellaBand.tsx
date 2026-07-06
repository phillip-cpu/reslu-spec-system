"use client";

import { useState } from "react";
import { umbrellaGridPosition } from "@/lib/gantt";
import type { GanttGrid } from "@/lib/gantt";

/**
 * Renders the "Site Setup" umbrella phase as a full-width band row —
 * visually distinct from ordinary phase rows (a hatched/dashed
 * treatment rather than a solid bar, so it still reads as a different
 * KIND of row — whole-of-job preliminaries, not a single trade's
 * visit-bearing phase) but, as of Fix Round A, its start/end dates ARE
 * editable, same as any ordinary phase (BUILD-SPEC.md "Site Setup
 * umbrella span" item 3: "editable start/end like a normal phase").
 *
 * Tap the name/dates to expand an inline date-edit row (mirrors the
 * ordinary PhaseRow's edit-panel interaction — click to expand —
 * without pulling in that component's full form, since the umbrella
 * has no color_key/contact_id/notes fields worth editing here: it
 * never gets trade visits or trade emails, per BUILD-SPEC, so there is
 * nothing else on it to edit). The Preliminaries & Site content
 * tooltip (line descriptions from the linked cost section) stays a
 * separate read-only expand, unchanged from Phase 11A.
 */
export function UmbrellaBand({
  name,
  startDate,
  endDate,
  grid,
  costSectionLines,
  onPatch,
}: {
  name: string;
  startDate: string;
  endDate: string;
  grid: GanttGrid;
  costSectionLines: string[];
  onPatch: (patch: { name?: string; start_date?: string; end_date?: string }) => void;
}) {
  const [contentOpen, setContentOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftStart, setDraftStart] = useState(startDate);
  const [draftEnd, setDraftEnd] = useState(endDate);
  const pos = umbrellaGridPosition({ start_date: startDate, end_date: endDate }, grid);

  function saveDates() {
    const patch: { start_date?: string; end_date?: string } = {};
    if (draftStart !== startDate) patch.start_date = draftStart;
    if (draftEnd !== endDate) patch.end_date = draftEnd;
    if (Object.keys(patch).length > 0) onPatch(patch);
    setEditing(false);
  }

  return (
    <>
      <div className="col-start-1 border-b border-r border-[#e5e0d6] bg-cream/60 px-3 py-2">
        <button
          type="button"
          onClick={() => setContentOpen((o) => !o)}
          className="text-left text-body text-charcoal/70 hover:text-sand"
        >
          {name}
        </button>
        <p className="text-caption text-charcoal/40">Whole-of-job preliminaries</p>
        <button
          type="button"
          onClick={() => {
            setDraftStart(startDate);
            setDraftEnd(endDate);
            setEditing((o) => !o);
          }}
          className="mt-1 text-caption text-charcoal/50 underline hover:text-nearblack"
        >
          {editing ? "Cancel" : "Edit dates"}
        </button>
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
          title={`${name}: ${startDate} to ${endDate}`}
        />
      </div>

      {editing && (
        <div className="col-span-full flex flex-wrap items-end gap-3 border-b border-[#dcd6cc] bg-offwhite px-3 py-3">
          <label className="flex flex-col gap-1">
            <span className="label-caps">Start</span>
            <input
              type="date"
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-caps">End</span>
            <input
              type="date"
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={saveDates}
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
          >
            Save
          </button>
          <p className="text-caption text-charcoal/40">
            No trade visits or trade emails apply to this band — it&apos;s a summary period only.
          </p>
        </div>
      )}

      {contentOpen && (
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
            This band is bound to the Preliminaries &amp; Site estimate section — its content list
            above stays read-only, but its dates can be edited (see &quot;Edit dates&quot;).
          </p>
        </div>
      )}
    </>
  );
}
