"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import type { Measurement, MeasurementGroupWithRows } from "@/types";
import { measurementGroupTotal } from "@/lib/estimate";

interface Props {
  projectId: string;
  groups: MeasurementGroupWithRows[];
  /** Full re-fetch — reserved for structural changes (add/rename/delete group). */
  onReload: () => void;
  /** Week 7 line-entry UX fix — fold a created/changed/removed row into local state, no re-fetch. */
  onMeasurementAdded: (groupId: string, measurement: Measurement) => void;
  onMeasurementChanged: (groupId: string, measurement: Measurement) => void;
  onMeasurementRemoved: (groupId: string, measurementId: string) => void;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Areas & Measurements tab: groups (Floor Areas, Tiling Areas seeded as
 * default groups on init) with label/value/unit rows + per-group
 * total. BUILD-SPEC.md "Areas & Measurements: groups ... with
 * label/value/unit rows + per-group total."
 *
 * Week 7 line-entry UX fix: new rows are entered as a draft row at the
 * bottom of each group (label/value/unit/notes, one POST); existing
 * rows accumulate edits locally and PATCH once on row blur / explicit
 * save — same pattern as EstimateView's LineRow/DraftLineRow.
 */
export function MeasurementsView({
  projectId,
  groups,
  onReload,
  onMeasurementAdded,
  onMeasurementChanged,
  onMeasurementRemoved,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  async function addGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/measurements/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add group.");
      }
      setNewGroupName("");
      setAddingGroup(false);
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add group.");
    }
  }

  async function renameGroup(id: string, name: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/measurements/groups/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not rename group.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename group.");
    }
  }

  async function deleteGroup(id: string, name: string) {
    if (!confirm(`Delete group "${name}" and all its rows?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/estimate/measurements/groups/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not delete group.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete group.");
    }
  }

  async function addRowDraft(
    groupId: string,
    draft: { label: string; value: number | null; unit: string | null; notes: string | null }
  ) {
    const res = await fetch(`/api/estimate/measurements/groups/${groupId}/measurements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: draft.label,
        value: draft.value ?? undefined,
        unit: draft.unit ?? undefined,
        notes: draft.notes ?? undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not add row.");
    }
    const { measurement } = await res.json();
    onMeasurementAdded(groupId, measurement as Measurement);
  }

  async function patchRow(
    groupId: string,
    id: string,
    patch: Record<string, unknown>
  ): Promise<Measurement> {
    const res = await fetch(`/api/estimate/measurements/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not update row.");
    }
    const { measurement } = await res.json();
    onMeasurementChanged(groupId, measurement as Measurement);
    return measurement as Measurement;
  }

  async function deleteRow(groupId: string, id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/measurements/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not remove row.");
      }
      onMeasurementRemoved(groupId, id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove row.");
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.id} className="border border-[#dcd6cc]">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-cream px-4 py-3">
            <GroupNameEditor name={group.name} onRename={(name) => renameGroup(group.id, name)} />
            <div className="flex items-center gap-4">
              <span className="text-body text-nearblack">
                {measurementGroupTotal(group.measurements.map((m) => m.value))}{" "}
                {group.measurements[0]?.unit ?? "m2"}
              </span>
              <button
                type="button"
                onClick={() => deleteGroup(group.id, group.name)}
                className="text-caption text-red-700/70 hover:text-red-700"
              >
                Delete group
              </button>
            </div>
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[#dcd6cc] text-left">
                <th className="label-caps px-2 py-1.5">Label / room</th>
                <th className="label-caps px-2 py-1.5 text-right">Value</th>
                <th className="label-caps px-2 py-1.5">Unit</th>
                <th className="label-caps px-2 py-1.5">Notes</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {group.measurements.map((m) => (
                <MeasurementRow
                  key={m.id}
                  measurement={m}
                  onPatch={(patch) => patchRow(group.id, m.id, patch)}
                  onDelete={() => deleteRow(group.id, m.id)}
                />
              ))}
              <DraftMeasurementRow
                groupId={group.id}
                onAdd={(draft) => addRowDraft(group.id, draft)}
              />
            </tbody>
          </table>
        </section>
      ))}

      {addingGroup ? (
        <form onSubmit={addGroup} className="flex items-center gap-2 border border-[#dcd6cc] bg-offwhite p-4">
          <input
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Group name, e.g. Wall Areas"
            className="min-w-[200px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
          <button type="submit" className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal">
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAddingGroup(false);
              setNewGroupName("");
            }}
            className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAddingGroup(true)}
          className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
        >
          + Add group
        </button>
      )}
    </div>
  );
}

/**
 * Week 7 line-entry UX fix: edits accumulate in local `draft` state and
 * PATCH once on row blur or the tick button — mirrors
 * components/estimate/EstimateView.tsx's LineRow.
 */
function MeasurementRow({
  measurement,
  onPatch,
  onDelete,
}: {
  measurement: Measurement;
  onPatch: (patch: Record<string, unknown>) => Promise<Measurement>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Measurement>(measurement);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);

  if (!dirty && measurement.updated_at !== draft.updated_at) {
    setDraft(measurement);
  }

  function setField<K extends keyof Measurement>(key: K, value: Measurement[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setRowError(null);
    try {
      const updated = await onPatch({
        label: draft.label,
        value: draft.value ?? 0,
        unit: draft.unit || "m2",
        notes: draft.notes,
      });
      setDraft(updated);
      setDirty(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not save this row.");
    } finally {
      setSaving(false);
    }
  }

  function handleRowBlur(e: React.FocusEvent<HTMLTableRowElement>) {
    if (rowRef.current && e.relatedTarget && rowRef.current.contains(e.relatedTarget as Node)) {
      return;
    }
    save();
  }

  return (
    <tr ref={rowRef} onBlur={handleRowBlur} className={clsx("border-b border-[#e5e0d6]", dirty && "bg-cream/60")}>
      <td className="min-w-[180px] px-0 py-0">
        <div className="flex items-center">
          <div className="flex-1">
            <EditableText value={draft.label} onCommit={(v) => v && setField("label", v)} />
          </div>
          {dirty && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={save}
              disabled={saving}
              title="Save this row"
              aria-label="Save this row"
              className="mr-1 shrink-0 text-caption text-sand hover:text-nearblack disabled:opacity-50"
            >
              {saving ? "…" : "✓"}
            </button>
          )}
        </div>
        {rowError && <p className="px-2 pb-1 text-caption text-red-700">⚠ {rowError}</p>}
      </td>
      <td className="w-24 px-0 py-0">
        <EditableNumber value={draft.value} onCommit={(v) => setField("value", v ?? 0)} />
      </td>
      <td className="w-20 px-0 py-0">
        <EditableText value={draft.unit} onCommit={(v) => setField("unit", v || "m2")} />
      </td>
      <td className="min-w-[160px] px-0 py-0">
        <EditableText value={draft.notes} onCommit={(v) => setField("notes", v || null)} />
      </td>
      <td className="px-1 py-1.5">
        <button type="button" onClick={onDelete} className="text-caption text-red-700/60 hover:text-red-700">
          ✕
        </button>
      </td>
    </tr>
  );
}

/**
 * New-row draft (Week 7 line-entry UX fix) — label/value/unit/notes
 * collected in one row, posted in a single request on Enter or "Add",
 * then cleared for rapid entry (mirrors components/items/SpecRegister.tsx's
 * AddItemForm).
 */
function DraftMeasurementRow({
  groupId,
  onAdd,
}: {
  groupId: string;
  onAdd: (draft: {
    label: string;
    value: number | null;
    unit: string | null;
    notes: string | null;
  }) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("m2");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!label.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd({
        label: label.trim(),
        value: value === "" ? null : Number(value),
        unit: unit.trim() || null,
        notes: notes.trim() || null,
      });
      setLabel("");
      setValue("");
      setNotes("");
      // unit deliberately persists between adds — measurement rows in
      // the same group are usually the same unit (e.g. all m2), so
      // resetting it every time would just mean re-typing it.
      labelRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add row.");
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
    <tr id={`draft-measurement-${groupId}`} className="border-b border-[#e5e0d6] bg-offwhite/60">
      <td className="min-w-[180px] px-0 py-0">
        <input
          ref={labelRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="+ Add row — label / room"
          className="w-full border-none bg-transparent px-2 py-1.5 text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
        {error && <p className="px-2 pb-1 text-caption text-red-700">⚠ {error}</p>}
      </td>
      <td className="w-24 px-0 py-0">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Value"
          className="w-full border-none bg-transparent px-2 py-1.5 text-right text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="w-20 px-0 py-0">
        <input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Unit"
          className="w-full border-none bg-transparent px-2 py-1.5 text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="min-w-[160px] px-0 py-0">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Notes"
          className="w-full border-none bg-transparent px-2 py-1.5 text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="px-1 py-1.5">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !label.trim()}
          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
        >
          {submitting ? "…" : "Add"}
        </button>
      </td>
    </tr>
  );
}

function GroupNameEditor({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() && draft.trim() !== name) onRename(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
        className="border border-nearblack bg-nearwhite px-2 py-1 text-subhead text-nearblack focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      className="label-caps !text-nearblack hover:!text-sand"
    >
      {name}
    </button>
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
      className={`block w-full px-2 py-1.5 text-left text-body hover:bg-nearwhite ${!value ? "text-charcoal/30" : ""}`}
    >
      {value || "—"}
    </button>
  );
}

function EditableNumber({
  value,
  onCommit,
}: {
  value: number;
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
      className="block w-full px-2 py-1.5 text-right text-body hover:bg-nearwhite"
    >
      {value}
    </button>
  );
}
