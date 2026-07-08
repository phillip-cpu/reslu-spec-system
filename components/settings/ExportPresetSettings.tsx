"use client";

import { useState } from "react";
import type { Category } from "@/types";
import type { ExportPresetRow } from "@/types/round-export-batch";

interface Props {
  initialPresets: ExportPresetRow[];
  categories: Category[];
  canEdit: boolean;
}

/**
 * Export preset editor — BUILD-SPEC.md "Export + board batch" item 1:
 * "named trade presets stored in app_settings 'export_presets'
 * [{name, prefixes[]}] ... editable in Settings, add/remove presets."
 * Backed by GET/PUT /api/settings/export-presets. Mirrors
 * components/settings/PhaseTemplateSettings.tsx's exact shape (inline-
 * editable list + add form) — the closest existing precedent for "a
 * small ordered list of named things, admin-editable, no per-row
 * detail panel needed" — extended with a category multi-select
 * (checkboxes) in place of that component's single kind dropdown,
 * since a preset needs 1+ category prefixes rather than one enum
 * value.
 *
 * Presets are consumed by components/projects/ExportDialog.tsx (the
 * "Download PDF" replacement) as quick-pick chips that tick a subset
 * of that dialog's own category checkboxes.
 *
 * "Trade booking document pack" round (8 July 2026) addition: each row
 * gains a free-text "Applies to contact categories" input — comma-
 * separated, e.g. "Plumber, Plumbing" — backing ExportPresetRow's new
 * optional contact_categories field. Consumed by BookVisitPanel's
 * "Schedule" auto-pick (lib/export-presets.ts's
 * pickPresetForContactCategory()) to match a booking's contact
 * category against a preset without staff having to rename the preset
 * itself to match the Address Book's own category wording.
 *
 * "Order-by engine" round (8 July 2026) — COPY ONLY, no structural
 * change: BUILD-SPEC.md "Single mapping = export presets (no new
 * mapping table): presets already carry prefixes[] + contact_
 * categories[] — this IS categories<->trade<->contacts. Settings copy
 * updated to present presets as 'Trade mappings' ... used by BOTH
 * schedule exports and ordering deadlines." This component's own name,
 * exported symbol, props, and every field it reads/writes are
 * UNCHANGED — only the on-page heading/helper text below is reworded
 * to explain the SECOND consumer (the order-by engine, lib/order-by.ts)
 * alongside the original one (schedule PDF exports), so staff editing
 * this list understand a change here now also shifts ORDER BY dates in
 * the Pricing & Procurement view, not just which categories a Download-
 * PDF preset ticks.
 */
export function ExportPresetSettings({ initialPresets, categories, canEdit }: Props) {
  const [rows, setRows] = useState<ExportPresetRow[]>(initialPresets);
  const [name, setName] = useState("");
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [contactCategories, setContactCategories] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Comma-separated free text -> trimmed, non-empty array — shared by the add form and each row's inline edit below. */
  function parseContactCategories(value: string): string[] {
    return value
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  async function save(next: ExportPresetRow[]) {
    setSaving(true);
    setError(null);
    const prev = rows;
    setRows(next);
    try {
      const res = await fetch("/api/settings/export-presets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presets: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      const { presets } = await res.json();
      setRows(presets);
    } catch (err) {
      setRows(prev);
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || prefixes.length === 0) return;
    const cleanedCategories = parseContactCategories(contactCategories);
    save([
      ...rows,
      {
        name: name.trim(),
        prefixes: [...prefixes],
        ...(cleanedCategories.length > 0 ? { contact_categories: cleanedCategories } : {}),
      },
    ]);
    setName("");
    setPrefixes([]);
    setContactCategories("");
  }

  /** Inline edit of a row's contact_categories — same trim/split-on-comma parsing as the add form, applied on blur so a partial in-progress edit doesn't save on every keystroke. Empty input clears the field entirely (an explicit choice, not merged with the old value). */
  function updateContactCategories(index: number, value: string) {
    const cleaned = parseContactCategories(value);
    save(
      rows.map((r, i) => {
        if (i !== index) return r;
        const next = { ...r };
        if (cleaned.length > 0) next.contact_categories = cleaned;
        else delete next.contact_categories;
        return next;
      })
    );
  }

  function remove(index: number) {
    const row = rows[index];
    if (!confirm(`Remove the "${row.name}" export preset?`)) return;
    save(rows.filter((_, i) => i !== index));
  }

  function rename(index: number, newName: string) {
    if (!newName.trim()) return;
    save(rows.map((r, i) => (i === index ? { ...r, name: newName.trim() } : r)));
  }

  function togglePrefixOnRow(index: number, prefix: string) {
    const row = rows[index];
    const has = row.prefixes.includes(prefix);
    const nextPrefixes = has ? row.prefixes.filter((p) => p !== prefix) : [...row.prefixes, prefix];
    if (nextPrefixes.length === 0) {
      setError("A preset needs at least one category.");
      return;
    }
    save(rows.map((r, i) => (i === index ? { ...r, prefixes: nextPrefixes } : r)));
  }

  return (
    <div className="max-w-3xl space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
        {rows.map((row, index) => (
          <div key={`${row.name}-${index}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            {canEdit ? (
              <input
                defaultValue={row.name}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== row.name) rename(index, e.target.value);
                }}
                className="w-40 shrink-0 bg-transparent px-2 py-1 text-body hover:bg-nearwhite focus:border focus:border-nearblack focus:bg-nearwhite focus:outline-none"
              />
            ) : (
              <span className="w-40 shrink-0 px-2 py-1 text-body">{row.name}</span>
            )}
            <div className="flex flex-1 flex-wrap gap-2">
              {categories.map((c) => {
                const checked = row.prefixes.includes(c.prefix);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-1 text-caption text-charcoal/70"
                    title={c.name}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canEdit}
                      onChange={() => togglePrefixOnRow(index, c.prefix)}
                      className="h-3 w-3"
                    />
                    {c.prefix}
                  </label>
                );
              })}
            </div>
            {/* "Trade booking document pack" round — applies-to contact
                categories, matched against contacts.category by
                BookVisitPanel's Schedule auto-pick. Free text,
                comma-separated; blank means "no explicit mapping —
                fall through to the name heuristic / full schedule". */}
            {canEdit ? (
              <input
                defaultValue={(row.contact_categories ?? []).join(", ")}
                onBlur={(e) => updateContactCategories(index, e.target.value)}
                placeholder="Applies to contact categories, e.g. Plumber"
                title="Applies to contact categories"
                className="w-56 shrink-0 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
              />
            ) : (
              (row.contact_categories?.length ?? 0) > 0 && (
                <span className="text-caption text-charcoal/50">
                  {row.contact_categories!.join(", ")}
                </span>
              )
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => remove(index)}
                className="shrink-0 text-caption text-charcoal/50 hover:text-red-700"
              >
                Delete
              </button>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="px-4 py-3 text-caption text-charcoal/40">No export presets yet.</p>
        )}
      </div>

      {canEdit && (
        <form onSubmit={add} className="space-y-2 border border-[#c9c2b4] bg-nearwhite p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="label-caps">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Tiler"
                className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={saving || !name.trim() || prefixes.length === 0}
              className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {saving ? "Adding…" : "Add preset"}
            </button>
          </div>
          <div>
            <span className="label-caps mb-1 block">Categories</span>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => {
                const checked = prefixes.includes(c.prefix);
                return (
                  <label key={c.id} className="flex items-center gap-1 text-caption text-charcoal/70" title={c.name}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setPrefixes((cur) => [...cur, c.prefix]);
                        else setPrefixes((cur) => cur.filter((p) => p !== c.prefix));
                      }}
                      className="h-3 w-3"
                    />
                    {c.prefix}
                  </label>
                );
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="label-caps">Applies to contact categories</span>
            <input
              value={contactCategories}
              onChange={(e) => setContactCategories(e.target.value)}
              placeholder="e.g. Plumber, Plumbing (optional)"
              className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
        </form>
      )}
    </div>
  );
}
