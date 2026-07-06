"use client";

import { useState } from "react";
import type { PhaseTaskTemplateRow, PhaseTaskTemplatesMap } from "@/types/board-cockpit";

interface Props {
  /** Every phase NAME currently in the phase template (app_settings 'phase_template') — the set of valid checklist keys, in seed order. Passed in rather than fetched here since the Settings page already has this list loaded for PhaseTemplateSettings right above this section. */
  phaseNames: string[];
  initialTemplates: PhaseTaskTemplatesMap;
  canEdit: boolean;
}

/**
 * Phase task template editor — Board cockpit round (7 July 2026)
 * chat-agreed improvement: "phase task templates via app_settings
 * 'phase_task_templates' seeded on phase seed." One checklist per
 * phase name (from the phase template directly above this section on
 * the Settings page); each checklist is an ordered list of { title,
 * kind } rows seeded as board_tasks cards under that phase's group the
 * next time a NEW project's phases are seeded (lib/phase-seed.ts) —
 * editing here never touches an already-seeded project, same "only
 * affects future seeds" model as PhaseTemplateSettings.tsx.
 *
 * Mirrors that sibling component's exact interaction shape (inline-
 * editable list + add form) one level deeper: a phase name section,
 * each with its own small ordered task list + add-task form.
 */
export function PhaseTaskTemplateSettings({ phaseNames, initialTemplates, canEdit }: Props) {
  const [templates, setTemplates] = useState<PhaseTaskTemplatesMap>(initialTemplates);
  const [activePhase, setActivePhase] = useState<string>(phaseNames[0] ?? "");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"task" | "milestone">("task");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: PhaseTaskTemplatesMap) {
    setSaving(true);
    setError(null);
    const prev = templates;
    setTemplates(next);
    try {
      const res = await fetch("/api/settings/phase-task-templates", {
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

  function rowsFor(phaseName: string): PhaseTaskTemplateRow[] {
    return templates[phaseName] ?? [];
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !activePhase) return;
    const next = { ...templates, [activePhase]: [...rowsFor(activePhase), { title: title.trim(), kind }] };
    save(next);
    setTitle("");
    setKind("task");
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
    return <p className="text-body text-charcoal/50">Add a phase to the default phase template above first.</p>;
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
              <span className="w-20 shrink-0 text-caption uppercase tracking-wide text-charcoal/50">
                {row.kind === "milestone" ? "Milestone" : "Task"}
              </span>
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
          <label className="flex flex-col gap-1">
            <span className="label-caps">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "task" | "milestone")}
              className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
            >
              <option value="task">Task</option>
              <option value="milestone">Milestone</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="label-caps">Task title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`e.g. Confirm ${activePhase.toLowerCase()} trade`}
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
