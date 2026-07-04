"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import type { Contact, PhaseColorKey, SchedulePhaseWithContact } from "@/types";
import { computeGanttGrid, isNewMonth, monthLabel, phaseGridPosition } from "@/lib/gantt";

interface Props {
  projectId: string;
  initialPhases: SchedulePhaseWithContact[];
}

const COLOR_KEYS: PhaseColorKey[] = ["sand", "charcoal", "teal", "amber"];

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
 */
export function GanttChart({ projectId, initialPhases }: Props) {
  const [phases, setPhases] = useState<SchedulePhaseWithContact[]>(initialPhases);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const grid = useMemo(() => computeGanttGrid(phases), [phases]);

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
      setPhases((cur) => [...cur, { ...phase, contact: null }]);
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add phase.");
    }
  }

  async function patchPhase(
    phase: SchedulePhaseWithContact,
    patch: Record<string, unknown>,
    refUpdate?: Partial<SchedulePhaseWithContact>
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

  async function deletePhase(phase: SchedulePhaseWithContact) {
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

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {phases.length === 0 ? (
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">No phases yet. Add the first one to start the timeline.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-[#dcd6cc]">
          <div
            className="grid"
            style={{ gridTemplateColumns: `200px repeat(${grid.weekCount}, minmax(28px, 1fr))` }}
          >
            {/* Header row: phase-name column header + month labels spanning weeks */}
            <div className="border-b border-r border-[#dcd6cc] bg-cream px-3 py-2">
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

            {/* One row per phase */}
            {phases.map((phase) => {
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
                />
              );
            })}
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
}: {
  phase: SchedulePhaseWithContact;
  gridPos: { startCol: number; span: number };
  weekCount: number;
  editing: boolean;
  onToggleEdit: () => void;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<SchedulePhaseWithContact>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="col-start-1 border-b border-r border-[#e5e0d6] px-3 py-2">
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
          <PhaseEditPanel phase={phase} onPatch={onPatch} onDelete={onDelete} />
        </div>
      )}
    </>
  );
}

function PhaseEditPanel({
  phase,
  onPatch,
  onDelete,
}: {
  phase: SchedulePhaseWithContact;
  onPatch: (patch: Record<string, unknown>, refUpdate?: Partial<SchedulePhaseWithContact>) => void;
  onDelete: () => void;
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

  return (
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
