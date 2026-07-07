"use client";

import { useEffect, useMemo, useState } from "react";
import type { Category } from "@/types";
import type { ExportPresetRow } from "@/types/round-export-batch";
import { FALLBACK_EXPORT_PRESETS, categoriesQueryValue } from "@/lib/export-presets";

interface Props {
  projectId: string;
  projectName: string;
  /** Every category present on the project's own item set (used to build the checkbox list — a project with no TW items shouldn't show a TW checkbox). */
  categoriesInProject: Category[];
  onClose: () => void;
}

/**
 * Export dialog — replaces the bare "Download PDF" link (BUILD-SPEC.md
 * "Export + board batch" item 1). Opened from the project page header
 * (see app/(dashboard)/projects/[id]/page.tsx) via a small trigger
 * button, same "own small file, popover-shaped" convention as
 * components/board/BookVisitPanel.tsx (this file's closest styling
 * precedent — fixed inset-0 dim backdrop + a centred cream card).
 *
 * Preset chips tick a matching subset of the category checkboxes below
 * them (never the other way around — ticking/unticking an individual
 * checkbox after choosing a preset silently becomes "Custom", tracked
 * via `activePresetName`). Categories present on the project default
 * to ALL TICKED (full schedule) per the brief's "all ticked default =
 * full schedule".
 */
export function ExportDialog({ projectId, projectName, categoriesInProject, onClose }: Props) {
  const [presets, setPresets] = useState<ExportPresetRow[]>(FALLBACK_EXPORT_PRESETS);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(categoriesInProject.map((c) => c.prefix))
  );
  const [activePresetName, setActivePresetName] = useState<string | null>(null);
  const [includeDocs, setIncludeDocs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/export-presets")
      .then((r) => (r.ok ? r.json() : { presets: FALLBACK_EXPORT_PRESETS }))
      .then((body) => {
        if (!cancelled) setPresets(body.presets ?? FALLBACK_EXPORT_PRESETS);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const allPrefixes = useMemo(() => categoriesInProject.map((c) => c.prefix), [categoriesInProject]);
  const isFullSchedule = selected.size === allPrefixes.length;

  // Only offer preset chips whose categories actually exist on this
  // project — a "Plumber" preset pointing at TW/SW on a project with
  // no wet-area items would just tick nothing, which is confusing
  // rather than helpful.
  const applicablePresets = presets.filter((p) => p.prefixes.some((prefix) => allPrefixes.includes(prefix)));

  function applyPreset(preset: ExportPresetRow) {
    const next = new Set(preset.prefixes.filter((p) => allPrefixes.includes(p)));
    setSelected(next);
    setActivePresetName(preset.name);
  }

  function toggleCategory(prefix: string) {
    setActivePresetName(null);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }

  function selectAll() {
    setActivePresetName(null);
    setSelected(new Set(allPrefixes));
  }

  const presetOrCustomLabel = isFullSchedule ? null : activePresetName ?? "Custom";
  const filenameHintLabel = `${projectName} — ${presetOrCustomLabel ? `${presetOrCustomLabel} ` : ""}schedule`;

  const downloadHref = useMemo(() => {
    const params = new URLSearchParams();
    if (!isFullSchedule && selected.size > 0) {
      params.set("categories", categoriesQueryValue([...selected]));
    }
    if (includeDocs) params.set("docs", "1");
    params.set("filename", `${filenameHintLabel.replace(/[^a-z0-9]+/gi, "-")}.pdf`);
    const qs = params.toString();
    return `/api/projects/${projectId}/pdf${qs ? `?${qs}` : ""}`;
  }, [projectId, isFullSchedule, selected, includeDocs, filenameHintLabel]);

  const nothingSelected = selected.size === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg space-y-4 border border-[#dcd6cc] bg-cream p-6"
      >
        <div className="flex items-center justify-between">
          <p className="label-caps">Export FF&amp;E schedule</p>
          <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
            Close
          </button>
        </div>

        {applicablePresets.length > 0 && (
          <div>
            <span className="label-caps mb-1.5 block !text-charcoal/40">Trade presets</span>
            <div className="flex flex-wrap gap-2">
              {applicablePresets.map((preset) => {
                const active = activePresetName === preset.name;
                return (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={
                      active
                        ? "border border-nearblack bg-nearblack px-3 py-1.5 text-caption text-white"
                        : "border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
                    }
                  >
                    {preset.name}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={selectAll}
                className={
                  isFullSchedule
                    ? "border border-nearblack bg-nearblack px-3 py-1.5 text-caption text-white"
                    : "border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
                }
              >
                Full schedule
              </button>
            </div>
          </div>
        )}

        <div>
          <span className="label-caps mb-1.5 block !text-charcoal/40">Categories</span>
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto border border-[#e5e0d6] bg-nearwhite p-2.5">
            {categoriesInProject.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 text-caption text-charcoal/70" title={c.name}>
                <input
                  type="checkbox"
                  checked={selected.has(c.prefix)}
                  onChange={() => toggleCategory(c.prefix)}
                  className="h-3 w-3"
                />
                {c.prefix} · {c.name}
              </label>
            ))}
            {categoriesInProject.length === 0 && (
              <span className="text-caption text-charcoal/40">No items in this project yet.</span>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-caption text-charcoal/70">
          <input type="checkbox" checked={includeDocs} onChange={(e) => setIncludeDocs(e.target.checked)} className="h-3 w-3" />
          Include item documents (spec sheets &amp; install manuals, merged into one PDF)
        </label>

        <p className="text-caption text-charcoal/40">Filename: {filenameHintLabel}.pdf</p>

        {nothingSelected ? (
          <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
            Select at least one category.
          </p>
        ) : (
          <a
            href={downloadHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="block w-full bg-nearblack px-4 py-2.5 text-center text-subhead text-white hover:bg-charcoal"
          >
            Download{includeDocs ? " print bundle" : " PDF"}
          </a>
        )}
      </div>
    </div>
  );
}
