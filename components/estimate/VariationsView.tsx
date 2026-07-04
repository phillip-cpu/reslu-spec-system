"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import type { Variation, VariationStatus } from "@/types";
import { variationIncGst } from "@/lib/estimate";
import { formatMoney } from "./EstimateWorkspace";

interface Props {
  projectId: string;
  variations: Variation[];
  /** Full re-fetch — no longer used for routine row edits (Week 7), kept for parity/future structural changes. */
  onReload: () => void;
  /** Week 7 line-entry UX fix — fold a created/changed/removed variation into local state, no re-fetch. */
  onVariationAdded: (variation: Variation) => void;
  onVariationChanged: (variation: Variation) => void;
  onVariationRemoved: (id: string) => void;
}

const STATUSES: VariationStatus[] = ["proposed", "approved", "rejected"];

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Variations Register: var#, date, description, cost ex GST, computed
 * inc GST, status select, approved by, requested by, notes; total row.
 * BUILD-SPEC.md "Variations: register table per the Excel ...".
 *
 * Week 7 line-entry UX fix: new variations are entered as a draft row
 * (description + cost, the two fields worth filling before the row
 * exists) and posted in one request; existing rows accumulate edits
 * locally and PATCH once on row blur / explicit save, same pattern as
 * components/estimate/EstimateView.tsx's LineRow/DraftLineRow.
 */
export function VariationsView({
  projectId,
  variations,
  onReload,
  onVariationAdded,
  onVariationChanged,
  onVariationRemoved,
}: Props) {
  void onReload; // reserved for future structural changes; routine edits no longer use it.
  const [error, setError] = useState<string | null>(null);

  const totalExGst = variations.reduce((sum, v) => sum + (v.cost_ex_gst ?? 0), 0);
  const totalIncGst = variations.reduce((sum, v) => sum + (variationIncGst(v.cost_ex_gst) ?? 0), 0);

  async function addVariationDraft(draft: { description: string; cost_ex_gst: number | null }) {
    const res = await fetch(`/api/projects/${projectId}/estimate/variations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: draft.description,
        cost_ex_gst: draft.cost_ex_gst ?? undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not add variation.");
    }
    const { variation } = await res.json();
    onVariationAdded(variation as Variation);
  }

  async function patchVariation(id: string, patch: Record<string, unknown>): Promise<Variation> {
    const res = await fetch(`/api/estimate/variations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not update variation.");
    }
    const { variation } = await res.json();
    onVariationChanged(variation as Variation);
    return variation as Variation;
  }

  async function deleteVariation(id: string, varNumber: number) {
    if (!confirm(`Delete variation #${varNumber}?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/estimate/variations/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not delete variation.");
      }
      onVariationRemoved(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete variation.");
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto border border-[#dcd6cc]">
        <table className="w-full min-w-[1100px] border-collapse">
          <thead>
            <tr className="border-b border-[#dcd6cc] bg-cream text-left">
              <th className="label-caps px-2 py-2">Var#</th>
              <th className="label-caps px-2 py-2">Date</th>
              <th className="label-caps px-2 py-2">Description</th>
              <th className="label-caps px-2 py-2 text-right">Cost ex GST</th>
              <th className="label-caps px-2 py-2 text-right">Cost inc GST</th>
              <th className="label-caps px-2 py-2">Status</th>
              <th className="label-caps px-2 py-2">Approved by</th>
              <th className="label-caps px-2 py-2">Requested by</th>
              <th className="label-caps px-2 py-2">Notes</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {variations.map((v) => (
              <VariationRow
                key={v.id}
                variation={v}
                onPatch={(patch) => patchVariation(v.id, patch)}
                onDelete={() => deleteVariation(v.id, v.var_number)}
              />
            ))}
            <DraftVariationRow onAdd={addVariationDraft} />
          </tbody>
          {variations.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-nearblack bg-offwhite font-medium">
                <td colSpan={3} className="px-2 py-2 text-body text-nearblack">
                  Total
                </td>
                <td className="px-2 py-2 text-right text-body text-nearblack">
                  {formatMoney(totalExGst)}
                </td>
                <td className="px-2 py-2 text-right text-body text-nearblack">
                  {formatMoney(totalIncGst)}
                </td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/**
 * Week 7 line-entry UX fix: edits accumulate in local `draft` state and
 * PATCH once on row blur or the tick button — mirrors
 * components/estimate/EstimateView.tsx's LineRow. The date input keeps
 * its own onBlur-only commit (unchanged shape) since a native date
 * picker's "change" already only fires on a complete, deliberate pick.
 */
function VariationRow({
  variation,
  onPatch,
  onDelete,
}: {
  variation: Variation;
  onPatch: (patch: Record<string, unknown>) => Promise<Variation>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Variation>(variation);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);

  if (!dirty && variation.updated_at !== draft.updated_at) {
    setDraft(variation);
  }

  function setField<K extends keyof Variation>(key: K, value: Variation[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setRowError(null);
    try {
      const updated = await onPatch({
        var_date: draft.var_date,
        description: draft.description,
        cost_ex_gst: draft.cost_ex_gst ?? 0,
        status: draft.status,
        approved_by: draft.approved_by,
        requested_by: draft.requested_by,
        notes: draft.notes,
      });
      setDraft(updated);
      setDirty(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not save this variation.");
    } finally {
      setSaving(false);
    }
  }

  async function patchNow(patch: Record<string, unknown>) {
    setRowError(null);
    try {
      const updated = await onPatch(patch);
      setDraft(updated);
      setDirty(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not update this variation.");
    }
  }

  function handleRowBlur(e: React.FocusEvent<HTMLTableRowElement>) {
    if (rowRef.current && e.relatedTarget && rowRef.current.contains(e.relatedTarget as Node)) {
      return;
    }
    save();
  }

  return (
    <tr ref={rowRef} onBlur={handleRowBlur} className={clsx("border-b border-[#e5e0d6] align-top", dirty && "bg-cream/60")}>
      <td className="whitespace-nowrap px-2 py-2 text-body text-nearblack">
        VAR-{String(draft.var_number).padStart(2, "0")}
        {dirty && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={saving}
            title="Save this variation"
            aria-label="Save this variation"
            className="ml-1.5 text-caption text-sand hover:text-nearblack disabled:opacity-50"
          >
            {saving ? "…" : "✓"}
          </button>
        )}
      </td>
      <td className="px-1 py-1">
        <input
          type="date"
          value={draft.var_date}
          onChange={(e) => setField("var_date", e.target.value)}
          className="border-none bg-transparent px-1 py-1 text-body focus:outline-none"
        />
      </td>
      <td className="min-w-[200px] px-0 py-0">
        <EditableText value={draft.description} onCommit={(val) => val && setField("description", val)} />
        {rowError && <p className="px-2 pb-1 text-caption text-red-700">⚠ {rowError}</p>}
      </td>
      <td className="w-28 px-0 py-0">
        <EditableNumber value={draft.cost_ex_gst} onCommit={(val) => setField("cost_ex_gst", val ?? 0)} />
      </td>
      <td className="px-2 py-2 text-right text-body text-charcoal/70">
        {formatMoney(variationIncGst(draft.cost_ex_gst) ?? 0)}
      </td>
      <td className="px-1 py-1">
        <select
          value={draft.status}
          onChange={(e) => patchNow({ status: e.target.value })}
          className={clsx(
            "bg-transparent py-1 text-body focus:outline-none",
            draft.status === "approved" && "text-nearblack",
            draft.status === "rejected" && "text-red-700/70"
          )}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </td>
      <td className="min-w-[120px] px-0 py-0">
        <EditableText value={draft.approved_by} onCommit={(val) => setField("approved_by", val || null)} />
      </td>
      <td className="min-w-[120px] px-0 py-0">
        <EditableText value={draft.requested_by} onCommit={(val) => setField("requested_by", val || null)} />
      </td>
      <td className="min-w-[140px] px-0 py-0">
        <EditableText value={draft.notes} onCommit={(val) => setField("notes", val || null)} />
      </td>
      <td className="px-1 py-2">
        <button type="button" onClick={onDelete} className="text-caption text-red-700/60 hover:text-red-700">
          ✕
        </button>
      </td>
    </tr>
  );
}

/**
 * New-variation draft row (Week 7 line-entry UX fix) — description +
 * cost ex GST are the two fields worth filling before the row exists;
 * everything else (status, approved/requested by, notes) is edited on
 * the real row afterwards, same as before. Enter or "Add" posts in one
 * request; the row clears and refocuses for rapid entry.
 */
function DraftVariationRow({
  onAdd,
}: {
  onAdd: (draft: { description: string; cost_ex_gst: number | null }) => Promise<void>;
}) {
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!description.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd({
        description: description.trim(),
        cost_ex_gst: cost === "" ? null : Number(cost),
      });
      setDescription("");
      setCost("");
      descRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add variation.");
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  return (
    <tr className="border-b border-[#e5e0d6] bg-offwhite/60 align-top">
      <td className="px-2 py-2 text-caption text-charcoal/30">New</td>
      <td />
      <td className="min-w-[200px] px-0 py-0">
        <input
          ref={descRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="+ Add variation — description"
          className="w-full border-none bg-transparent px-2 py-1.5 text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
        {error && <p className="px-2 pb-1 text-caption text-red-700">⚠ {error}</p>}
      </td>
      <td className="w-28 px-0 py-0">
        <input
          type="number"
          step="any"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Cost ex GST"
          className="w-full border-none bg-transparent px-2 py-1.5 text-right text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td colSpan={5} />
      <td className="px-1 py-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !description.trim()}
          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
        >
          {submitting ? "…" : "Add"}
        </button>
      </td>
    </tr>
  );
}

function EditableText({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() !== (value ?? "").trim()) onCommit(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full border border-nearblack bg-nearwhite px-2 py-1.5 text-body text-charcoal focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      className={clsx("block w-full px-2 py-1.5 text-left text-body hover:bg-nearwhite", !value && "text-charcoal/30")}
    >
      {value || "—"}
    </button>
  );
}

function EditableNumber({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(num(value));

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = draft === "" ? null : Number(draft);
          if (next !== value) onCommit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full border border-nearblack bg-nearwhite px-2 py-1.5 text-right text-body text-charcoal focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(num(value));
        setEditing(true);
      }}
      className={clsx("block w-full px-2 py-1.5 text-right text-body hover:bg-nearwhite", value === null && "text-charcoal/30")}
    >
      {value !== null ? value : "—"}
    </button>
  );
}
