"use client";

import { useState } from "react";
import type { AppSettingsPhaseTemplateRow } from "@/types/phase-fix-a";

interface Props {
  initialTemplate: AppSettingsPhaseTemplateRow[];
  canEdit: boolean;
}

/**
 * Phase template editor — BUILD-SPEC.md "Pre-populated phases":
 * "template stored in app_settings key 'phase_template', editable via
 * a simple list editor in the Settings page." Backed by
 * GET/PUT /api/settings/phase-template. Mirrors
 * components/settings/CategorySettings.tsx's shape (inline-editable
 * list + add form), the closest existing precedent for "a small
 * ordered list of named things, admin-editable, no per-row detail
 * panel needed."
 *
 * Editing here changes what NEW projects (or projects whose
 * Timeline/Board hasn't been visited yet) get seeded with — see
 * lib/phase-seed.ts's seedPhaseTemplateIfEmpty(), which reads this
 * same app_settings row. Already-seeded projects are untouched
 * (BUILD-SPEC.md's "seed on first visit" model is per-project and
 * one-time).
 */
export function PhaseTemplateSettings({ initialTemplate, canEdit }: Props) {
  const [rows, setRows] = useState<AppSettingsPhaseTemplateRow[]>(initialTemplate);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"phase" | "umbrella">("phase");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: AppSettingsPhaseTemplateRow[]) {
    setSaving(true);
    setError(null);
    const prev = rows;
    setRows(next);
    try {
      const res = await fetch("/api/settings/phase-template", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      const { template } = await res.json();
      setRows(template);
    } catch (err) {
      setRows(prev);
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (kind === "umbrella" && rows.some((r) => r.kind === "umbrella")) {
      setError("Only one umbrella phase is allowed — edit the existing one instead.");
      return;
    }
    save([...rows, { name: name.trim(), kind }]);
    setName("");
    setKind("phase");
  }

  function rename(index: number, newName: string) {
    if (!newName.trim()) return;
    const next = rows.map((r, i) => (i === index ? { ...r, name: newName.trim() } : r));
    save(next);
  }

  function remove(index: number) {
    const row = rows[index];
    if (row.kind === "umbrella") {
      setError("The umbrella phase can't be removed — rename it instead if needed.");
      return;
    }
    if (!confirm(`Remove "${row.name}" from the default phase template?`)) return;
    save(rows.filter((_, i) => i !== index));
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  }

  return (
    <div className="max-w-2xl space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
        {rows.map((row, index) => (
          <div key={`${row.name}-${index}`} className="flex items-center gap-3 px-4 py-2">
            <span className="w-24 shrink-0 text-caption uppercase tracking-wide text-charcoal/50">
              {row.kind === "umbrella" ? "Umbrella" : "Phase"}
            </span>
            {canEdit ? (
              <input
                defaultValue={row.name}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== row.name) rename(index, e.target.value);
                }}
                className="flex-1 bg-transparent px-2 py-1 text-body hover:bg-nearwhite focus:border focus:border-nearblack focus:bg-nearwhite focus:outline-none"
              />
            ) : (
              <span className="flex-1 px-2 py-1 text-body">{row.name}</span>
            )}
            {canEdit && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="text-caption text-charcoal/50 hover:text-nearblack disabled:opacity-30"
                >
                  Up
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                  className="text-caption text-charcoal/50 hover:text-nearblack disabled:opacity-30"
                >
                  Down
                </button>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="text-caption text-charcoal/50 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="label-caps">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "phase" | "umbrella")}
              className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
            >
              <option value="phase">Phase</option>
              <option value="umbrella">Umbrella</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="label-caps">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Painting"
              className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
          >
            {saving ? "Adding…" : "Add phase"}
          </button>
        </form>
      )}
    </div>
  );
}
