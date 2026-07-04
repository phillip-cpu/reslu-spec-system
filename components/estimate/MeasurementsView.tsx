"use client";

import { useState } from "react";
import type { MeasurementGroupWithRows } from "@/types";
import { measurementGroupTotal } from "@/lib/estimate";

interface Props {
  projectId: string;
  groups: MeasurementGroupWithRows[];
  onReload: () => void;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Areas & Measurements tab: groups (Floor Areas, Tiling Areas seeded as
 * default groups on init) with label/value/unit rows + per-group
 * total. BUILD-SPEC.md "Areas & Measurements: groups ... with
 * label/value/unit rows + per-group total."
 */
export function MeasurementsView({ projectId, groups, onReload }: Props) {
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

  async function addRow(groupId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/measurements/groups/${groupId}/measurements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "New area" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add row.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add row.");
    }
  }

  async function patchRow(id: string, patch: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/measurements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not update row.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update row.");
    }
  }

  async function deleteRow(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/measurements/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not remove row.");
      }
      onReload();
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
              {group.measurements.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-4 text-center text-body text-charcoal/50">
                    No rows yet.
                  </td>
                </tr>
              ) : (
                group.measurements.map((m) => (
                  <tr key={m.id} className="border-b border-[#e5e0d6]">
                    <td className="min-w-[180px] px-0 py-0">
                      <EditableText
                        value={m.label}
                        onCommit={(v) => v && patchRow(m.id, { label: v })}
                      />
                    </td>
                    <td className="w-24 px-0 py-0">
                      <EditableNumber
                        value={m.value}
                        onCommit={(v) => patchRow(m.id, { value: v ?? 0 })}
                      />
                    </td>
                    <td className="w-20 px-0 py-0">
                      <EditableText value={m.unit} onCommit={(v) => patchRow(m.id, { unit: v || "m2" })} />
                    </td>
                    <td className="min-w-[160px] px-0 py-0">
                      <EditableText value={m.notes} onCommit={(v) => patchRow(m.id, { notes: v || null })} />
                    </td>
                    <td className="px-1 py-1.5">
                      <button
                        type="button"
                        onClick={() => deleteRow(m.id)}
                        className="text-caption text-red-700/60 hover:text-red-700"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="border-t border-[#e5e0d6] px-4 py-2">
            <button
              type="button"
              onClick={() => addRow(group.id)}
              className="text-subhead text-sand hover:text-nearblack"
            >
              + Add row
            </button>
          </div>
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
