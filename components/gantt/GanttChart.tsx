"use client";

// ============================================================
// Timeline v2 (Phase 11A) — rendering decision, documented per the
// build spec:
//
// A schedule_phases row can now hold MANY trade_visits. Rather than
// inventing a new multi-row-per-phase grid layout (which would break
// the existing one-row-per-phase CSS grid math this file and
// lib/gantt.ts already share with the read-only portal mirror), each
// phase row keeps its single bar, with a COMPACT overview strip of
// small status dots (one per visit, see components/gantt/VisitBar.tsx)
// rendered just below/alongside the bar. The FULL detail for each
// visit — contact, dates, arrival, status, edit/delete — lives in the
// phase's EXISTING expand-on-click edit panel (PhaseEditPanel below),
// which already exists as a col-span-full row beneath the phase row.
// This reuses an interaction pattern staff already know (click phase
// name to expand) instead of adding a second one, and keeps
// lib/gantt.ts's row-per-phase grid math completely untouched — visits
// never need their own grid row, only their own grid-position
// coordinates within the shared week grid (see lib/gantt.ts's
// visitGridPosition, used inside the edit panel's per-visit list, and
// the compact dots above, which don't need grid coordinates at all
// since they're laid out as a simple flex strip, not positioned bars).
// ============================================================

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Contact, PhaseColorKey } from "@/types";
import type { SchedulePhaseWithVisits, TradeVisitWithContact, ArrivalSlot } from "@/lib/trade-visits";
import { formatArrival } from "@/lib/trade-visits";
import {
  computeGanttGrid,
  isNewMonth,
  monthLabel,
  phaseGridPosition,
  todayGridPosition,
} from "@/lib/gantt";
import { VisitBar, VisitStatusLabel } from "./VisitBar";
import { UmbrellaBand } from "./UmbrellaBand";
import { CompletedPhasesGroup } from "./CompletedPhasesGroup";
import { VisitBottomSheet } from "./VisitBottomSheet";

interface Props {
  projectId: string;
  initialPhases: SchedulePhaseWithVisits[];
}

const COLOR_KEYS: PhaseColorKey[] = ["sand", "charcoal", "teal", "amber"];
const WIDE_GRID_THRESHOLD = 12; // weeks — above this, the zoom toggle appears (BUILD-SPEC "week/month zoom")

/**
 * Bar fill colours — brand-muted per BUILD-SPEC.md ("brand-muted bar
 * colours"). sand/charcoal are the actual brand palette; teal/amber
 * are additional accent tones for Gantt differentiation (migration
 * 013's color_key check constraint comment) — kept muted/desaturated
 * so they read as brand-adjacent rather than introducing loud new
 * brand colours.
 */
const COLOR_SWATCH: Record<PhaseColorKey, string> = {
  sand: "#A08C72",
  charcoal: "#313131",
  teal: "#5F8A82",
  amber: "#B98A4A",
};

/**
 * Gantt (Timeline tab) — BUILD-SPEC.md "Gantt": CSS-grid table, left
 * column phase names, columns = weeks spanning min(start) to max(end)
 * (capped 52, month labels header), bars positioned by grid-column
 * start/span, inline edit panel per phase, add-phase form. See
 * lib/gantt.ts for the week-grid math shared by this component.
 *
 * Timeline v2 additions (Phase 11A): trade-visit overview dots per
 * phase row (full detail in the edit panel), an auto-maintained
 * umbrella band ("Site Setup"), a week/month zoom toggle for wide
 * grids, a collapsible "Completed" group, a today-line marker, a
 * sticky phase-name column for mobile horizontal scroll, and a mobile
 * bottom sheet for tapping a visit dot.
 */
export function GanttChart({ projectId, initialPhases }: Props) {
  const [phases, setPhases] = useState<SchedulePhaseWithVisits[]>(initialPhases);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [zoom, setZoom] = useState<"week" | "month">("week");
  const [sheetVisit, setSheetVisit] = useState<TradeVisitWithContact | null>(null);

  const umbrella = phases.find((p) => p.kind === "umbrella") ?? null;
  const ordinaryPhases = useMemo(() => phases.filter((p) => p.kind === "phase"), [phases]);

  const grid = useMemo(
    () => computeGanttGrid(ordinaryPhases.length > 0 ? ordinaryPhases : phases),
    [ordinaryPhases, phases]
  );

  const todayPos = useMemo(() => todayGridPosition(grid), [grid]);
  const showZoomToggle = grid.weekCount > WIDE_GRID_THRESHOLD;
  // Week/month zoom (BUILD-SPEC "week/month zoom toggle for >12-week
  // grids"): rather than re-deriving a whole separate month-column
  // grid (which would need its own math in lib/gantt.ts and its own
  // bar-position formula), "month" mode reuses the EXACT SAME week
  // grid and instead widens each week column's minmax floor so fewer
  // columns are visible without scrolling and only every 4th week
  // renders a visible gridline/label — a defensible, low-risk way to
  // get a "zoomed out" feel within lib/gantt.ts's existing math
  // without a rewrite.
  const colMinWidth = zoom === "month" ? "10px" : "28px";

  const today = new Date().toISOString().slice(0, 10);
  const completedPhases = useMemo(
    () => ordinaryPhases.filter((p) => p.end_date < today),
    [ordinaryPhases, today]
  );
  const activePhases = useMemo(
    () => ordinaryPhases.filter((p) => p.end_date >= today),
    [ordinaryPhases, today]
  );

  async function addPhase(input: {
    name: string;
    start_date: string;
    end_date: string;
    color_key: PhaseColorKey;
  }) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/phases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add phase.");
      const { phase } = await res.json();
      setPhases((cur) => [...cur, { ...phase, contact: null, visits: [] }]);
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add phase.");
    }
  }

  async function patchPhase(
    phase: SchedulePhaseWithVisits,
    patch: Record<string, unknown>,
    refUpdate?: Partial<SchedulePhaseWithVisits>
  ) {
    const prev = phases;
    setPhases((cur) =>
      cur.map((p) => (p.id === phase.id ? { ...p, ...patch, ...refUpdate } : p))
    );
    setError(null);
    try {
      const res = await fetch(`/api/phases/${phase.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update phase.");
      const { phase: updated } = await res.json();
      setPhases((cur) => cur.map((p) => (p.id === phase.id ? { ...p, ...updated } : p)));
    } catch (err) {
      setPhases(prev);
      setError(err instanceof Error ? err.message : "Could not update phase.");
    }
  }

  async function deletePhase(phase: SchedulePhaseWithVisits) {
    if (!confirm(`Remove phase "${phase.name}"?`)) return;
    const prev = phases;
    setPhases((cur) => cur.filter((p) => p.id !== phase.id));
    setEditingId(null);
    const res = await fetch(`/api/phases/${phase.id}`, { method: "DELETE" });
    if (!res.ok) {
      setPhases(prev);
      setError("Could not remove phase.");
    }
  }

  function replaceVisit(phaseId: string, visit: TradeVisitWithContact) {
    setPhases((cur) =>
      cur.map((p) =>
        p.id === phaseId ? { ...p, visits: p.visits.map((v) => (v.id === visit.id ? visit : v)) } : p
      )
    );
  }

  function addVisitToPhase(phaseId: string, visit: TradeVisitWithContact) {
    setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, visits: [...p.visits, visit] } : p)));
  }

  function removeVisitFromPhase(phaseId: string, visitId: string) {
    setPhases((cur) =>
      cur.map((p) => (p.id === phaseId ? { ...p, visits: p.visits.filter((v) => v.id !== visitId) } : p))
    );
  }

  function renderPhaseRow(phase: SchedulePhaseWithVisits) {
    const pos = phaseGridPosition(phase, grid);
    return (
      <PhaseRow
        key={phase.id}
        phase={phase}
        gridPos={pos}
        weekCount={grid.weekCount}
        editing={editingId === phase.id}
        onToggleEdit={() => setEditingId((cur) => (cur === phase.id ? null : phase.id))}
        onPatch={(patch, refUpdate) => patchPhase(phase, patch, refUpdate)}
        onDelete={() => deletePhase(phase)}
        onTapVisit={setSheetVisit}
        onAddVisit={(v) => addVisitToPhase(phase.id, v)}
        onPatchVisit={(v) => replaceVisit(phase.id, v)}
        onDeleteVisit={(id) => removeVisitFromPhase(phase.id, id)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {showZoomToggle && (
        <div className="flex items-center gap-2">
          <span className="label-caps">Zoom</span>
          <button
            type="button"
            onClick={() => setZoom("week")}
            className={clsx(
              "border px-3 py-1 text-caption",
              zoom === "week" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal"
            )}
          >
            Week
          </button>
          <button
            type="button"
            onClick={() => setZoom("month")}
            className={clsx(
              "border px-3 py-1 text-caption",
              zoom === "month" ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal"
            )}
          >
            Month
          </button>
        </div>
      )}

      {phases.length === 0 ? (
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">No phases yet. Add the first one to start the timeline.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-[#dcd6cc]">
          <div
            className="relative grid"
            style={{ gridTemplateColumns: `200px repeat(${grid.weekCount}, minmax(${colMinWidth}, 1fr))` }}
          >
            {/* Today line — an absolutely-positioned vertical marker
                spanning every row, computed via the same week-grid math
                used for phase bars. */}
            {todayPos && (
              <div
                className="pointer-events-none absolute inset-y-0 z-10 w-px bg-sand"
                style={{
                  left: `calc(200px + ((100% - 200px) / ${grid.weekCount}) * ${todayPos.startCol - 1})`,
                }}
                title="Today"
              />
            )}

            {/* Header row: sticky phase-name column header + month labels spanning weeks */}
            <div className="sticky left-0 z-20 border-b border-r border-[#dcd6cc] bg-cream px-3 py-2">
              <span className="label-caps">Phase</span>
            </div>
            {grid.weeks.map((week, i) => (
              <div
                key={i}
                className="border-b border-[#e5e0d6] bg-cream px-1 py-2 text-center"
              >
                {isNewMonth(grid.weeks, i) && (
                  <span className="label-caps whitespace-nowrap">{monthLabel(week)}</span>
                )}
              </div>
            ))}

            {/* Umbrella band ("Site Setup") — always renders first if present.
                Fix Round A: dates are now editable like any normal phase
                (onPatch below reuses the exact same patchPhase() helper
                every ordinary PhaseRow uses) — see UmbrellaBand.tsx's own
                doc comment for the span-fix rationale. */}
            {umbrella && (
              <UmbrellaBand
                name={umbrella.name}
                startDate={umbrella.start_date}
                endDate={umbrella.end_date}
                grid={grid}
                costSectionLines={umbrella.cost_section_lines ?? []}
                onPatch={(patch) => patchPhase(umbrella, patch)}
              />
            )}

            {/* Active (not-yet-completed) phases render directly */}
            {activePhases.map(renderPhaseRow)}

            {/* Completed phases collapse into one group, expandable */}
            <CompletedPhasesGroup phases={completedPhases} weekCount={grid.weekCount} renderRow={renderPhaseRow} />
          </div>
        </div>
      )}

      {adding ? (
        <AddPhaseForm onAdd={addPhase} onCancel={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
        >
          + Add phase
        </button>
      )}

      {sheetVisit && (
        <VisitBottomSheet
          visit={sheetVisit}
          onClose={() => setSheetVisit(null)}
          onConfirmed={(updated) => {
            replaceVisit(updated.phase_id, updated);
            setSheetVisit(updated);
          }}
        />
      )}
    </div>
  );
}

function PhaseRow({
  phase,
  gridPos,
  weekCount,
  editing,
  onToggleEdit,
  onPatch,
  onDelete,
  onTapVisit,
  onAddVisit,
  onPatchVisit,
  onDeleteVisit,
}: {
  phase: SchedulePhaseWithVisits;
  gridPos: { startCol: number; span: number };
  weekCount: number;
  editing: boolean;
  onToggleEdit: () => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<SchedulePhaseWithVisits>) => void;
  onDelete: () => void;
  onTapVisit: (visit: TradeVisitWithContact) => void;
  onAddVisit: (visit: TradeVisitWithContact) => void;
  onPatchVisit: (visit: TradeVisitWithContact) => void;
  onDeleteVisit: (visitId: string) => void;
}) {
  return (
    <>
      <div className="sticky left-0 z-10 col-start-1 border-b border-r border-[#e5e0d6] bg-nearwhite px-3 py-2">
        <button
          type="button"
          onClick={onToggleEdit}
          className="text-left text-body text-nearblack hover:text-sand"
        >
          {phase.name}
        </button>
        <p className="text-caption text-charcoal/40">
          {phase.start_date} → {phase.end_date}
        </p>
        {phase.visits.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {phase.visits.slice(0, 6).map((v) => (
              <VisitBar
                key={v.id}
                companyLabel={v.contact?.company ?? "Trade"}
                status={v.status}
                onTap={() => onTapVisit(v)}
              />
            ))}
            {phase.visits.length > 6 && (
              <span className="text-caption text-charcoal/40">+{phase.visits.length - 6}</span>
            )}
          </div>
        )}
      </div>
      <div
        className="relative border-b border-[#e5e0d6] py-2"
        style={{ gridColumn: `2 / span ${weekCount}` }}
      >
        <div
          className="h-4"
          style={{
            marginLeft: `calc((100% / ${weekCount}) * ${gridPos.startCol - 1})`,
            width: `calc((100% / ${weekCount}) * ${gridPos.span})`,
            backgroundColor: COLOR_SWATCH[phase.color_key],
          }}
          title={`${phase.name}: ${phase.start_date} to ${phase.end_date}`}
        />
      </div>

      {editing && (
        <div className="col-span-full border-b border-[#dcd6cc] bg-offwhite px-3 py-3">
          <PhaseEditPanel
            phase={phase}
            onPatch={onPatch}
            onDelete={onDelete}
            onAddVisit={onAddVisit}
            onPatchVisit={onPatchVisit}
            onDeleteVisit={onDeleteVisit}
          />
        </div>
      )}
    </>
  );
}

function PhaseEditPanel({
  phase,
  onPatch,
  onDelete,
  onAddVisit,
  onPatchVisit,
  onDeleteVisit,
}: {
  phase: SchedulePhaseWithVisits;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<SchedulePhaseWithVisits>) => void;
  onDelete: () => void;
  onAddVisit: (visit: TradeVisitWithContact) => void;
  onPatchVisit: (visit: TradeVisitWithContact) => void;
  onDeleteVisit: (visitId: string) => void;
}) {
  const [name, setName] = useState(phase.name);
  const [start, setStart] = useState(phase.start_date);
  const [end, setEnd] = useState(phase.end_date);
  const [notes, setNotes] = useState(phase.notes ?? "");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);

  function openContactPicker() {
    setContactPickerOpen((o) => !o);
    if (!contactPickerOpen && contacts.length === 0) {
      fetch("/api/contacts")
        .then((r) => r.json())
        .then((body) => setContacts(body.contacts ?? []))
        .catch(() => {});
    }
  }

  // Umbrella phases render via components/gantt/UmbrellaBand.tsx
  // instead of this ordinary edit form (UmbrellaBand has its own
  // inline date editor as of Fix Round A, plus the read-only
  // Preliminaries & Site content panel). This branch exists
  // defensively (an umbrella row should never reach PhaseEditPanel
  // since GanttChart.tsx renders umbrellas via <UmbrellaBand> instead
  // of <PhaseRow>), but is kept here in case that invariant is ever
  // broken by a future change.
  if (phase.kind === "umbrella") {
    return (
      <div>
        <p className="label-caps mb-2">Preliminaries & Site content</p>
        <ul className="list-disc space-y-1 pl-4">
          {(phase.cost_section_lines ?? []).map((line, i) => (
            <li key={i} className="text-body text-charcoal">
              {line}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== phase.name && onPatch({ name: name.trim() })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Start date</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onBlur={() => start !== phase.start_date && onPatch({ start_date: start })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">End date</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={() => end !== phase.end_date && onPatch({ end_date: end })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Colour</span>
          <div className="flex items-center gap-1.5">
            {COLOR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onPatch({ color_key: key })}
                title={key}
                className={clsx(
                  "h-6 w-6 border",
                  phase.color_key === key ? "border-nearblack" : "border-transparent"
                )}
                style={{ backgroundColor: COLOR_SWATCH[key] }}
              />
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="label-caps">Notes</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => (notes.trim() || null) !== phase.notes && onPatch({ notes: notes.trim() || null })}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="label-caps">Contact</span>
          <button
            type="button"
            onClick={openContactPicker}
            className="border border-[#c9c2b4] px-2 py-1.5 text-left text-body text-charcoal hover:border-nearblack"
          >
            {phase.contact ? phase.contact.company : "None"}
          </button>
          {contactPickerOpen && (
            <div className="max-h-32 overflow-y-auto border border-[#c9c2b4] bg-nearwhite">
              <button
                type="button"
                onClick={() => {
                  onPatch({ contact_id: null }, { contact: null });
                  setContactPickerOpen(false);
                }}
                className="block w-full border-b border-[#e5e0d6] px-2 py-1 text-left text-caption text-charcoal/60 hover:bg-cream"
              >
                No link
              </button>
              {contacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onPatch(
                      { contact_id: c.id },
                      { contact: { id: c.id, company: c.company, contact_name: c.contact_name } }
                    );
                    setContactPickerOpen(false);
                  }}
                  className="block w-full border-b border-[#e5e0d6] px-2 py-1 text-left text-caption text-charcoal hover:bg-cream"
                >
                  {c.company}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={onDelete}
            className="border border-red-700/40 px-3 py-1.5 text-subhead text-red-700 transition-colors hover:bg-red-700 hover:text-white"
          >
            Remove phase
          </button>
        </div>
      </div>

      <VisitsPanel phase={phase} onAddVisit={onAddVisit} onPatchVisit={onPatchVisit} onDeleteVisit={onDeleteVisit} />
    </div>
  );
}

/**
 * Visit list + add-visit mini-form, nested inside the phase edit
 * panel — the "full detail" half of the rendering decision described
 * at the top of this file. Contact picker reuses the SAME
 * /api/contacts fetch pattern already used by the phase-level contact
 * picker above.
 */
function VisitsPanel({
  phase,
  onAddVisit,
  onPatchVisit,
  onDeleteVisit,
}: {
  phase: SchedulePhaseWithVisits;
  onAddVisit: (visit: TradeVisitWithContact) => void;
  onPatchVisit: (visit: TradeVisitWithContact) => void;
  onDeleteVisit: (visitId: string) => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="border-t border-[#dcd6cc] pt-3">
      <p className="label-caps mb-2">Trade visits</p>
      {phase.visits.length === 0 ? (
        <p className="mb-2 text-body text-charcoal/50">No visits scheduled yet.</p>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {phase.visits.map((visit) => (
            <VisitRow key={visit.id} visit={visit} onPatch={onPatchVisit} onDelete={onDeleteVisit} />
          ))}
        </ul>
      )}

      {adding ? (
        <AddVisitForm
          projectId={phase.project_id}
          phaseId={phase.id}
          onAdded={(v) => {
            onAddVisit(v);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
        >
          + Add visit
        </button>
      )}
    </div>
  );
}

function VisitRow({
  visit,
  onPatch,
  onDelete,
}: {
  visit: TradeVisitWithContact;
  onPatch: (visit: TradeVisitWithContact) => void;
  onDelete: (visitId: string) => void;
}) {
  const [start, setStart] = useState(visit.start_date);
  const [end, setEnd] = useState(visit.end_date);

  async function patch(patch: Record<string, unknown>) {
    const res = await fetch(`/api/visits/${visit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const { visit: updated } = await res.json();
      onPatch({ ...visit, ...updated });
    }
  }

  async function remove() {
    if (!confirm("Remove this visit?")) return;
    const res = await fetch(`/api/visits/${visit.id}`, { method: "DELETE" });
    if (res.ok) onDelete(visit.id);
  }

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-[#e5e0d6] pb-1.5 text-body">
      <span className="min-w-[110px] text-charcoal">{visit.contact?.company ?? "No trade"}</span>
      <input
        type="date"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={() => start !== visit.start_date && patch({ start_date: start })}
        className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
      />
      <input
        type="date"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={() => end !== visit.end_date && patch({ end_date: end })}
        className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-caption focus:border-nearblack focus:outline-none"
      />
      <span className="text-caption text-charcoal/50">{formatArrival(visit.arrival_slot, visit.arrival_time)}</span>
      <VisitStatusLabel status={visit.status} />
      <button type="button" onClick={remove} className="ml-auto text-caption text-red-700 hover:underline">
        Remove
      </button>
    </li>
  );
}

const SLOT_OPTIONS: { key: ArrivalSlot; label: string }[] = [
  { key: "first_thing", label: "First thing" },
  { key: "midday", label: "Midday" },
  { key: "afternoon", label: "Afternoon" },
];

function AddVisitForm({
  projectId,
  phaseId,
  onAdded,
  onCancel,
}: {
  projectId: string;
  phaseId: string;
  onAdded: (visit: TradeVisitWithContact) => void;
  onCancel: () => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState<string>("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [slot, setSlot] = useState<ArrivalSlot | "">("");
  const [time, setTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fix Round A — Trade insurance tracker: non-blocking warning
  // surfaced from the API response's insurance_warning flag (see
  // POST /api/projects/[id]/visits' doc comment). Shown alongside the
  // just-added visit rather than blocking the add — the visit is
  // already booked by the time this renders.
  const [insuranceWarning, setInsuranceWarning] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!start || !end) return;
    setSubmitting(true);
    setError(null);
    setInsuranceWarning(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/visits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase_id: phaseId,
          contact_id: contactId || null,
          start_date: start,
          end_date: end,
          arrival_slot: slot || null,
          arrival_time: time || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add visit.");
      const { visit, insurance_warning } = await res.json();
      const contact = contacts.find((c) => c.id === contactId) ?? null;
      onAdded({ ...visit, contact: contact ? { id: contact.id, company: contact.company, contact_name: contact.contact_name } : null });
      if (insurance_warning) setInsuranceWarning(insurance_warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add visit.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border border-[#c9c2b4] bg-nearwhite p-3">
      {error && <p className="w-full text-caption text-red-700">{error}</p>}
      {insuranceWarning && (
        <p className="w-full border border-sand bg-cream px-2 py-1.5 text-caption text-charcoal">
          {insuranceWarning}
        </p>
      )}
      <div className="min-w-[140px]">
        <label className="text-caption text-charcoal/60">Trade</label>
        <select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="block w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        >
          <option value="">None</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.company}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-caption text-charcoal/60">Start</label>
        <input
          type="date"
          required
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="text-caption text-charcoal/60">End</label>
        <input
          type="date"
          required
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="text-caption text-charcoal/60">Arrival</label>
        <select
          value={slot}
          onChange={(e) => setSlot(e.target.value as ArrivalSlot | "")}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        >
          <option value="">—</option>
          {SLOT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-caption text-charcoal/60">Or time</label>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="block border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
      >
        Cancel
      </button>
    </form>
  );
}

function AddPhaseForm({
  onAdd,
  onCancel,
}: {
  onAdd: (input: { name: string; start_date: string; end_date: string; color_key: PhaseColorKey }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [color, setColor] = useState<PhaseColorKey>("sand");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !start || !end) return;
    setSubmitting(true);
    try {
      await onAdd({ name: name.trim(), start_date: start, end_date: end, color_key: color });
      setName("");
      setStart("");
      setEnd("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="min-w-[200px] flex-1">
        <label className="label-caps mb-1 block">Name</label>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Demolition"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">Start</label>
        <input
          type="date"
          required
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">End</label>
        <input
          type="date"
          required
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">Colour</label>
        <div className="flex items-center gap-1.5 py-1">
          {COLOR_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setColor(key)}
              title={key}
              className={clsx("h-6 w-6 border", color === key ? "border-nearblack" : "border-transparent")}
              style={{ backgroundColor: COLOR_SWATCH[key] }}
            />
          ))}
        </div>
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
      >
        Cancel
      </button>
    </form>
  );
}
