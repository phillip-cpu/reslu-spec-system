"use client";

import { useState } from "react";
import type { DesignTaskTemplateRow, DesignTaskTemplatesMap } from "@/types/round-c";

interface Props {
  /** The fixed 7 design-phase names (types/phase-12b.ts's DESIGN_PHASE_TEMPLATE) — passed in rather than fetched here, same convention as PhaseTaskTemplateSettings' phaseNames prop. Unlike the phase (schedule) template, this list is NOT itself editable — the Design Framework's 7 phases are a fixed brief order (see that type's own doc comment: "NOT reorderable"). */
  phaseNames: readonly string[];
  initialTemplates: DesignTaskTemplatesMap;
  canEdit: boolean;
}

/**
 * Design task template editor — "Two from Phillip — 7 July 2026" item
 * 2: "Design board tasks pre-populated from the Monday template."
 * Structural mirror of components/settings/PhaseTaskTemplateSettings.tsx
 * one level simpler (rows are title-only — no kind/milestone toggle,
 * since design_tasks has no such concept, see types/phase-12b.ts's
 * DesignTask). Each checklist item here is seeded as a design_tasks row
 * under that phase the next time a NEW project's Design tab is first
 * opened (app/api/projects/[id]/design/route.ts) — editing here never
 * touches an already-seeded project, same "only affects future seeds"
 * model as every other template editor in this app.
 */
export function DesignTaskTemplateSettings({ phaseNames, initialTemplates, canEdit }: Props) {
  const [templates, setTemplates] = useState<DesignTaskTemplatesMap>(initialTemplates);
  const [activePhase, setActivePhase] = useState<string>(phaseNames[0] ?? "");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: DesignTaskTemplatesMap) {
    setSaving(true);
    setError(null);
    const prev = templates;
    setTemplates(next);
    try {
      const res = await fetch("/api/settings/design-task-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templates: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      const { templates: saved } = await res.json();
      setTemplates(saved);
    } catch (err) {
      setTemplates(prev);
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  function rowsFor(phaseName: string): DesignTaskTemplateRow[] {
    return templates[phaseName] ?? [];
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !activePhase) return;
    const next = { ...templates, [activePhase]: [...rowsFor(activePhase), { title: title.trim() }] };
    save(next);
    setTitle("");
  }

  function remove(phaseName: string, index: number) {
    const next = { ...templates, [phaseName]: rowsFor(phaseName).filter((_, i) => i !== index) };
    save(next);
  }

  function move(phaseName: string, index: number, dir: -1 | 1) {
    const rows = rowsFor(phaseName);
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    const nextRows = [...rows];
    [nextRows[index], nextRows[target]] = [nextRows[target], nextRows[index]];
    save({ ...templates, [phaseName]: nextRows });
  }

  if (phaseNames.length === 0) {
    return <p className="text-body text-charcoal/50">No design phases defined.</p>;
  }

  return (
    <div className="max-w-2xl space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        {phaseNames.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setActivePhase(name)}
            className={
              "border px-3 py-1.5 text-caption " +
              (activePhase === name
                ? "border-nearblack bg-nearblack text-white"
                : "border-[#c9c2b4] text-charcoal hover:border-nearblack")
            }
          >
            {name} · {rowsFor(name).length}
          </button>
        ))}
      </div>

      <div className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
        {rowsFor(activePhase).length === 0 ? (
          <p className="px-4 py-3 text-caption text-charcoal/50">No template tasks for &quot;{activePhase}&quot; yet.</p>
        ) : (
          rowsFor(activePhase).map((row, index) => (
            <div key={`${row.title}-${index}`} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1 px-2 py-1 text-body">{row.title}</span>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => move(activePhase, index, -1)}
                    disabled={index === 0}
                    className="text-caption text-charcoal/50 hover:text-nearblack disabled:opacity-30"
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    onClick={() => move(activePhase, index, 1)}
                    disabled={index === rowsFor(activePhase).length - 1}
                    className="text-caption text-charcoal/50 hover:text-nearblack disabled:opacity-30"
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(activePhase, index)}
                    className="text-caption text-charcoal/50 hover:text-red-700"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {canEdit && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="label-caps">Task title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`e.g. ${activePhase} deliverable`}
              className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={saving || !activePhase}
            className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
          >
            {saving ? "Adding…" : "Add task"}
          </button>
        </form>
      )}
    </div>
  );
}
