"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import type { CostLine, EstimateResponse, QuoteStatus } from "@/types";
import { lineCost, lineVariance } from "@/lib/estimate";
import { formatMoney } from "./EstimateWorkspace";
import { ItemLinkPicker } from "./ItemLinkPicker";

interface Props {
  projectId: string;
  estimate: EstimateResponse | null;
  notInitialised: boolean;
  onInitialise: () => void;
  onReload: () => void;
  approvedVariationsTotal: number;
}

const QUOTE_STATUSES: { value: QuoteStatus; label: string }[] = [
  { value: "Q", label: "Q — Quote received" },
  { value: "S", label: "S — Sent, waiting" },
  { value: "NA", label: "NA — Not applicable" },
];

function num(v: number | null): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * The Estimate tab: sticky summary block replicating the Excel's
 * summary layer, then sections as collapsible groups with inline-edit
 * line grids. BUILD-SPEC.md "Estimate: sections as collapsible groups
 * (cream headers, spaced-caps), lines grid with inline edit ...
 * sticky summary block at top ... 'Initialise from template' empty
 * state button; link icon on a line when item_id set".
 */
export function EstimateView({
  projectId,
  estimate,
  notInitialised,
  onInitialise,
  onReload,
  approvedVariationsTotal,
}: Props) {
  const [markupDraft, setMarkupDraft] = useState<string | null>(null);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (notInitialised) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="mb-4 text-body text-charcoal/60">
          No estimate yet for this project. Initialise it from the RESLU
          standard template — 22 sections covering prelims through to
          handover, ready to edit.
        </p>
        <button
          type="button"
          onClick={onInitialise}
          className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal"
        >
          Initialise from template
        </button>
      </div>
    );
  }

  if (!estimate) return null;

  const markupPercentDisplay =
    markupDraft !== null ? markupDraft : String(Math.round(estimate.markup_pct * 10000) / 100);

  function toggleSection(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function saveMarkup() {
    const percent = Number(markupPercentDisplay);
    if (!Number.isFinite(percent) || percent < 0) {
      setError("Markup must be a non-negative number.");
      return;
    }
    setSavingMarkup(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/markup`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markup_pct: percent / 100 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not update markup.");
      }
      setMarkupDraft(null);
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update markup.");
    } finally {
      setSavingMarkup(false);
    }
  }

  async function addSection(e: React.FormEvent) {
    e.preventDefault();
    if (!newSectionName.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newSectionName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add section.");
      }
      setNewSectionName("");
      setAddingSection(false);
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add section.");
    }
  }

  async function renameSection(id: string, name: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/sections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not rename section.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename section.");
    }
  }

  async function deleteSection(id: string, name: string) {
    if (!confirm(`Delete section "${name}" and all its lines? This can't be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/estimate/sections/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not delete section.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete section.");
    }
  }

  async function addLine(sectionId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/sections/${sectionId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "New line" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add line.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add line.");
    }
  }

  async function patchLine(id: string, patch: Partial<CostLine>) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/lines/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not update line.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update line.");
    }
  }

  async function deleteLine(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/lines/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not remove line.");
      }
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove line.");
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {/* Sticky summary block replicating the Excel's summary layer */}
      <div className="sticky top-0 z-10 border border-nearblack bg-cream px-6 py-4 shadow-sm">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCell label="All trades subtotal" value={formatMoney(estimate.rollup.allTradesSubtotalExGst)} />
          <SummaryCell
            label="Approved variations"
            value={formatMoney(approvedVariationsTotal)}
          />
          <div>
            <p className="label-caps mb-1">Markup %</p>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0"
                step="0.01"
                value={markupPercentDisplay}
                onChange={(e) => setMarkupDraft(e.target.value)}
                onBlur={saveMarkup}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                disabled={savingMarkup}
                className="w-20 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
              />
              <span className="text-body text-charcoal/50">%</span>
            </div>
          </div>
          <SummaryCell label="Markup $" value={formatMoney(estimate.rollup.markupExGst)} />
          <SummaryCell
            label="Total to client ex GST"
            value={formatMoney(estimate.rollup.totalToClientExGst)}
          />
          <SummaryCell label="GST (10%)" value={formatMoney(estimate.rollup.gst)} />
        </div>
        <div className="mt-3 border-t border-[#dcd6cc] pt-3">
          <p className="label-caps mb-1">Total inc GST</p>
          <p className="font-display text-section text-nearblack">
            {formatMoney(estimate.rollup.totalIncGst)}
          </p>
        </div>
      </div>

      {/* Sections */}
      {estimate.sections.map((section) => (
        <section key={section.id} className="border border-[#dcd6cc]">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-cream px-4 py-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggleSection(section.id)}
                className="text-charcoal/50 hover:text-nearblack"
                aria-label={expanded.has(section.id) ? "Collapse" : "Expand"}
              >
                {expanded.has(section.id) ? "−" : "+"}
              </button>
              <SectionNameEditor
                name={section.name}
                onRename={(name) => renameSection(section.id, name)}
              />
            </div>
            <div className="flex items-center gap-4">
              <span className="text-caption text-charcoal/50">
                {section.lines.length} {section.lines.length === 1 ? "line" : "lines"}
              </span>
              <span className="text-body text-nearblack">
                {formatMoney(section.rollup.costExGst)}
              </span>
              {section.rollup.variance !== null && (
                <span
                  className={clsx(
                    "text-body",
                    section.rollup.variance < 0 ? "text-red-700" : "text-charcoal/60"
                  )}
                >
                  var {formatMoney(section.rollup.variance)}
                </span>
              )}
              <button
                type="button"
                onClick={() => deleteSection(section.id, section.name)}
                className="text-caption text-red-700/70 hover:text-red-700"
              >
                Delete section
              </button>
            </div>
          </div>

          {expanded.has(section.id) && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse">
                <thead>
                  <tr className="border-b border-[#dcd6cc] text-left">
                    <th className="w-6" />
                    <th className="label-caps px-2 py-1.5">Description</th>
                    <th className="label-caps px-2 py-1.5 text-right">Qty</th>
                    <th className="label-caps px-2 py-1.5">Unit</th>
                    <th className="label-caps px-2 py-1.5 text-right">Rate ex GST</th>
                    <th className="label-caps px-2 py-1.5 text-right">Cost ex GST</th>
                    <th className="label-caps px-2 py-1.5 text-right">Quoted ex GST</th>
                    <th className="label-caps px-2 py-1.5 text-right">Actual ex GST</th>
                    <th className="label-caps px-2 py-1.5 text-right">Variance</th>
                    <th className="label-caps px-2 py-1.5">Status</th>
                    <th className="label-caps px-2 py-1.5">Notes</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {section.lines.map((line) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      onPatch={(patch) => patchLine(line.id, patch)}
                      onDelete={() => deleteLine(line.id)}
                    />
                  ))}
                </tbody>
              </table>
              <div className="border-t border-[#e5e0d6] px-4 py-2">
                <button
                  type="button"
                  onClick={() => addLine(section.id)}
                  className="text-subhead text-sand hover:text-nearblack"
                >
                  + Add line
                </button>
              </div>
            </div>
          )}
        </section>
      ))}

      {/* Add section */}
      {addingSection ? (
        <form onSubmit={addSection} className="flex items-center gap-2 border border-[#dcd6cc] bg-offwhite p-4">
          <input
            autoFocus
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            placeholder="Section name"
            className="min-w-[200px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
          <button
            type="submit"
            className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAddingSection(false);
              setNewSectionName("");
            }}
            className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAddingSection(true)}
          className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
        >
          + Add section
        </button>
      )}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label-caps mb-1">{label}</p>
      <p className="text-body text-nearblack">{value}</p>
    </div>
  );
}

function SectionNameEditor({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  if (editing) {
    return (
      <input
        ref={inputRef}
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

function LineRow({
  line,
  onPatch,
  onDelete,
}: {
  line: CostLine;
  onPatch: (patch: Partial<CostLine>) => void;
  onDelete: () => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const cost = lineCost(line);
  const variance = lineVariance(line);

  return (
    <>
      <tr className="border-b border-[#e5e0d6] align-top">
        <td className="pt-1.5">
          <button
            type="button"
            onClick={() => setLinkOpen((o) => !o)}
            title={line.item_id ? "Linked to a spec register item" : "Link to a spec register item"}
            className={clsx(
              "px-1 text-caption",
              line.item_id ? "text-sand" : "text-charcoal/25 hover:text-charcoal/60"
            )}
          >
            ⚭
          </button>
        </td>
        <td className="min-w-[220px] px-0 py-0">
          <EditableText
            value={line.description}
            onCommit={(v) => v && onPatch({ description: v })}
          />
        </td>
        <td className="w-20 px-0 py-0">
          <EditableNumber
            value={line.qty}
            onCommit={(v) => onPatch({ qty: v })}
          />
        </td>
        <td className="w-20 px-0 py-0">
          <EditableText value={line.unit} onCommit={(v) => onPatch({ unit: v || null })} />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber value={line.rate_ex_gst} onCommit={(v) => onPatch({ rate_ex_gst: v })} />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber
            value={line.cost_ex_gst}
            placeholder={cost !== null ? formatMoney(cost) : "—"}
            onCommit={(v) => onPatch({ cost_ex_gst: v })}
          />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber
            value={line.quoted_to_client_ex_gst}
            onCommit={(v) => onPatch({ quoted_to_client_ex_gst: v })}
          />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber
            value={line.actual_paid_ex_gst}
            onCommit={(v) => onPatch({ actual_paid_ex_gst: v })}
          />
        </td>
        <td className={clsx("w-24 px-2 py-1.5 text-right text-body", variance !== null && variance < 0 && "text-red-700")}>
          {variance !== null ? formatMoney(variance) : "—"}
        </td>
        <td className="px-1 py-1">
          <select
            value={line.quote_status ?? ""}
            onChange={(e) => onPatch({ quote_status: (e.target.value || null) as CostLine["quote_status"] })}
            className="bg-transparent py-1 text-body focus:outline-none"
          >
            <option value="">—</option>
            {QUOTE_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value}
              </option>
            ))}
          </select>
        </td>
        <td className="min-w-[140px] px-0 py-0">
          <EditableText value={line.notes} onCommit={(v) => onPatch({ notes: v || null })} />
        </td>
        <td className="px-1 py-1.5">
          <button
            type="button"
            onClick={() => {
              if (confirm(`Remove line "${line.description}"?`)) onDelete();
            }}
            className="text-caption text-red-700/60 hover:text-red-700"
          >
            ✕
          </button>
        </td>
      </tr>
      {linkOpen && (
        <tr className="border-b border-[#e5e0d6] bg-offwhite">
          <td />
          <td colSpan={11} className="px-2 py-3">
            <ItemLinkPicker
              projectId={line.project_id}
              currentItemId={line.item_id}
              onSelect={(itemId) => {
                onPatch({ item_id: itemId });
                setLinkOpen(false);
              }}
              onClose={() => setLinkOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function EditableText({
  value,
  onCommit,
  placeholder,
}: {
  value: string | null;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  if (editing) {
    return (
      <input
        ref={inputRef}
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
      {value || placeholder || "—"}
    </button>
  );
}

function EditableNumber({
  value,
  onCommit,
  placeholder,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  placeholder?: string;
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
      {value !== null ? value : placeholder || "—"}
    </button>
  );
}
