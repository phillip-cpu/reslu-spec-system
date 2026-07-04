"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import type { Variation, VariationStatus } from "@/types";
import { variationIncGst } from "@/lib/estimate";
import { formatMoney } from "./EstimateWorkspace";

interface Props {
  projectId: string;
  variations: Variation[];
  onReload: () => void;
}

const STATUSES: VariationStatus[] = ["proposed", "approved", "rejected"];

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Variations Register: var#, date, description, cost ex GST, computed
 * inc GST, status select, approved by, requested by, notes; total row.
 * BUILD-SPEC.md "Variations: register table per the Excel ...".
 */
export function VariationsView({ projectId, variations, onReload }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const totalExGst = variations.reduce((sum, v) => sum + (v.cost_ex_gst ?? 0), 0);
  const totalIncGst = variations.reduce((sum, v) => sum + (variationIncGst(v.cost_ex_gst) ?? 0), 0);

  async function addVariation(e: React.FormEvent) {
    e.preventDefault();
    if (!draftDescription.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/variations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: draftDescription.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add variation.");
      }
      setDraftDescription("");
      setAdding(false);
      onReload();
      nameRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add variation.");
    }
  }

  async function patchVariation(id: string, patch: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/variations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not update variation.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update variation.");
    }
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
      onReload();
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
            {variations.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-body text-charcoal/50">
                  No variations yet.
                </td>
              </tr>
            ) : (
              variations.map((v) => (
                <tr key={v.id} className="border-b border-[#e5e0d6] align-top">
                  <td className="whitespace-nowrap px-2 py-2 text-body text-nearblack">
                    VAR-{String(v.var_number).padStart(2, "0")}
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="date"
                      defaultValue={v.var_date}
                      onBlur={(e) => e.target.value !== v.var_date && patchVariation(v.id, { var_date: e.target.value })}
                      className="border-none bg-transparent px-1 py-1 text-body focus:outline-none"
                    />
                  </td>
                  <td className="min-w-[200px] px-0 py-0">
                    <EditableText
                      value={v.description}
                      onCommit={(val) => val && patchVariation(v.id, { description: val })}
                    />
                  </td>
                  <td className="w-28 px-0 py-0">
                    <EditableNumber
                      value={v.cost_ex_gst}
                      onCommit={(val) => patchVariation(v.id, { cost_ex_gst: val ?? 0 })}
                    />
                  </td>
                  <td className="px-2 py-2 text-right text-body text-charcoal/70">
                    {formatMoney(variationIncGst(v.cost_ex_gst) ?? 0)}
                  </td>
                  <td className="px-1 py-1">
                    <select
                      value={v.status}
                      onChange={(e) => patchVariation(v.id, { status: e.target.value })}
                      className={clsx(
                        "bg-transparent py-1 text-body focus:outline-none",
                        v.status === "approved" && "text-nearblack",
                        v.status === "rejected" && "text-red-700/70"
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
                    <EditableText
                      value={v.approved_by}
                      onCommit={(val) => patchVariation(v.id, { approved_by: val || null })}
                    />
                  </td>
                  <td className="min-w-[120px] px-0 py-0">
                    <EditableText
                      value={v.requested_by}
                      onCommit={(val) => patchVariation(v.id, { requested_by: val || null })}
                    />
                  </td>
                  <td className="min-w-[140px] px-0 py-0">
                    <EditableText
                      value={v.notes}
                      onCommit={(val) => patchVariation(v.id, { notes: val || null })}
                    />
                  </td>
                  <td className="px-1 py-2">
                    <button
                      type="button"
                      onClick={() => deleteVariation(v.id, v.var_number)}
                      className="text-caption text-red-700/60 hover:text-red-700"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
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

      {adding ? (
        <form onSubmit={addVariation} className="flex items-center gap-2 border border-[#dcd6cc] bg-offwhite p-4">
          <input
            ref={nameRef}
            autoFocus
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            placeholder="Variation description"
            className="min-w-[240px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
          <button type="submit" className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal">
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setDraftDescription("");
            }}
            className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
        >
          + Add variation
        </button>
      )}
    </div>
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
