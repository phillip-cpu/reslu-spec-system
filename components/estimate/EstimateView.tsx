"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Contact, CostLine, EstimateResponse, FfeCategoryRollup, MeasurementWithGroup, QuoteStatus } from "@/types";
import {
  effectiveQty,
  lineClientPrice,
  lineCost,
  lineProfitLoss,
} from "@/lib/estimate";
import { formatMoney } from "./EstimateWorkspace";
import { ItemLinkPicker } from "./ItemLinkPicker";
import { MeasurementLinkPicker } from "./MeasurementLinkPicker";
import { ContactLinkPicker } from "./ContactLinkPicker";
import { deliveryAllowanceLineInput } from "@/lib/delivery-costs";

interface Props {
  projectId: string;
  estimate: EstimateResponse | null;
  notInitialised: boolean;
  onInitialise: () => void;
  /** Full re-fetch — reserved for structural changes (init, add/rename/delete section). */
  onReload: () => void;
  /** Week 7 line-entry UX fix — fold a single created/changed/removed line into local state, no re-fetch. */
  onLineAdded: (line: CostLine) => void;
  onLineChanged: (line: CostLine) => void;
  onLineRemoved: (sectionId: string, lineId: string) => void;
  /** Optimistically apply a persisted line order within one section. */
  onLinesReordered: (sectionId: string, lineIds: string[]) => void;
  approvedVariationsTotal: number;
  /** Week 7 — Estimate ↔ Schedule integration: every project measurement, for the link picker + resolving a linked line's display. */
  measurements: MeasurementWithGroup[];
  onOpenQuoteRequests: () => void;
}

const QUOTE_STATUSES: { value: QuoteStatus; label: string }[] = [
  { value: "Q", label: "Q — Quote received" },
  { value: "S", label: "S — Sent, waiting" },
  { value: "NA", label: "NA — Not applicable" },
];

function num(v: number | null): string {
  return v === null || v === undefined ? "" : String(v);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
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
  onLineAdded,
  onLineChanged,
  onLineRemoved,
  onLinesReordered,
  approvedVariationsTotal,
  measurements,
  onOpenQuoteRequests,
}: Props) {
  const [markupDraft, setMarkupDraft] = useState<string | null>(null);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draggingLine, setDraggingLine] = useState<{ sectionId: string; lineId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    sectionId: string;
    lineId: string;
    edge: "before" | "after";
  } | null>(null);
  const [reorderingSectionId, setReorderingSectionId] = useState<string | null>(null);

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

  // Week 7 line-entry UX fix: adding a line no longer inserts a bare
  // "New line" row that then needs per-cell editing — see DraftLineRow
  // below, which collects the whole row (description/qty/unit/rate/
  // quoted/actual/status) and posts it in ONE request. `addLineDraft`
  // is what DraftLineRow calls on submit; on success it folds the new
  // line into local state via onLineAdded (no re-fetch) and the caller
  // clears the draft row for rapid entry, mirroring
  // components/items/SpecRegister.tsx's AddItemForm pattern.
  async function addLineDraft(sectionId: string, draft: NewLineInput) {
    const res = await fetch(`/api/estimate/sections/${sectionId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not add line.");
    }
    const { line } = await res.json();
    onLineAdded(line as CostLine);
  }

  async function addDeliveryAllowance(sectionId: string) {
    setError(null);
    try {
      await addLineDraft(sectionId, deliveryAllowanceLineInput());
      setExpanded((current) => new Set(current).add(sectionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the Delivery allowance.");
    }
  }

  // Optimistic single-row PATCH: the row itself (LineRow) has already
  // updated its own local draft state before calling this, so on
  // success we just fold the server's canonical row back in; on
  // failure the row rolls itself back and shows an inline error (see
  // LineRow's patchRow below) — this function never triggers a full
  // page/section reload.
  async function patchLine(line: CostLine, patch: Partial<CostLine>): Promise<CostLine> {
    const res = await fetch(`/api/estimate/lines/${line.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not update line.");
    }
    const { line: updated } = await res.json();
    onLineChanged(updated as CostLine);
    return updated as CostLine;
  }

  async function deleteLine(line: CostLine) {
    setError(null);
    try {
      const res = await fetch(`/api/estimate/lines/${line.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not remove line.");
      }
      onLineRemoved(line.section_id, line.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove line.");
    }
  }

  async function persistLineOrder(sectionId: string, nextLineIds: string[], previousLineIds: string[]) {
    if (nextLineIds.join("|") === previousLineIds.join("|")) return;

    onLinesReordered(sectionId, nextLineIds);
    setReorderingSectionId(sectionId);
    setError(null);
    try {
      const res = await fetch(`/api/estimate/sections/${sectionId}/lines/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_ids: nextLineIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not save the new line order.");
      }
    } catch (err) {
      onLinesReordered(sectionId, previousLineIds);
      setError(err instanceof Error ? err.message : "Could not save the new line order.");
    } finally {
      setReorderingSectionId(null);
    }
  }

  function reorderLine(
    sectionId: string,
    lineId: string,
    targetLineId: string,
    edge: "before" | "after"
  ) {
    if (reorderingSectionId) return;
    const section = estimate?.sections.find((candidate) => candidate.id === sectionId);
    if (!section || lineId === targetLineId) return;

    const previousLineIds = section.lines.map((line) => line.id);
    const nextLineIds = previousLineIds.filter((id) => id !== lineId);
    const targetIndex = nextLineIds.indexOf(targetLineId);
    if (targetIndex < 0) return;
    nextLineIds.splice(targetIndex + (edge === "after" ? 1 : 0), 0, lineId);
    void persistLineOrder(sectionId, nextLineIds, previousLineIds);
  }

  function moveLine(sectionId: string, lineId: string, delta: -1 | 1) {
    if (reorderingSectionId) return;
    const section = estimate?.sections.find((candidate) => candidate.id === sectionId);
    if (!section) return;
    const previousLineIds = section.lines.map((line) => line.id);
    const currentIndex = previousLineIds.indexOf(lineId);
    const nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= previousLineIds.length) return;

    const nextLineIds = [...previousLineIds];
    nextLineIds.splice(currentIndex, 1);
    nextLineIds.splice(nextIndex, 0, lineId);
    void persistLineOrder(sectionId, nextLineIds, previousLineIds);
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
          <SummaryCell
            label="Internal cost budget"
            value={formatMoney(estimate.rollup.allTradesSubtotalExGst)}
          />
          <SummaryCell
            label="Approved variations"
            value={formatMoney(approvedVariationsTotal)}
          />
          <div>
            <p className="label-caps mb-1">Default markup %</p>
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
          <SummaryCell
            label="Client price uplift"
            value={formatMoney(estimate.rollup.markupExGst)}
          />
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

      <div className="border border-[#dcd6cc] bg-offwhite px-4 py-3">
        <p className="label-caps mb-2">How each estimate line works</p>
        <div className="grid gap-2 text-caption text-charcoal/65 md:grid-cols-4">
          <p>
            <span className="text-nearblack">Budget cost</span> = quantity × unit cost,
            unless you enter an override.
          </p>
          <p>
            <span className="text-nearblack">Client price</span> = budget cost +{" "}
            {formatPercent(estimate.markup_pct)} default markup. Click it to override;
            clear it to return to automatic.
          </p>
          <p>
            <span className="text-nearblack">Actual cost</span> comes from approved
            supplier invoices.
          </p>
          <p>
            <span className="text-nearblack">Profit / loss</span> = client price −
            actual cost. A negative result is shown red.
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
              {reorderingSectionId === section.id && (
                <span className="text-caption text-sand" role="status">Saving order…</span>
              )}
              <span className="text-body text-nearblack">
                Budget {formatMoney(section.rollup.costExGst)}
              </span>
              {section.rollup.variance !== null && (
                <span
                  className={clsx(
                    "text-body",
                    section.rollup.variance < 0 ? "text-red-700" : "text-charcoal/60"
                  )}
                >
                  P/L {formatMoney(section.rollup.variance)}
                </span>
              )}
              <button
                type="button"
                onClick={() => void addDeliveryAllowance(section.id)}
                className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal hover:border-nearblack"
                title="Add a project delivery allowance. Actual supplier freight will reconcile here without changing FF&E library prices."
              >
                + Delivery allowance
              </button>
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
                    <th className="w-7">
                      <span className="sr-only">Reorder</span>
                    </th>
                    <th className="label-caps px-2 py-1.5">Description</th>
                    <th className="label-caps px-2 py-1.5 text-right">Qty</th>
                    <th className="label-caps px-2 py-1.5">Unit</th>
                    <EstimateColumnHeading
                      label="Unit cost"
                      detail="each · ex GST"
                      title="What RESLU expects to pay for one unit, day or item."
                    />
                    <EstimateColumnHeading
                      label="Budget cost"
                      detail="qty × unit · ex GST"
                      title="Internal expected cost. Automatically quantity × unit cost unless manually overridden."
                    />
                    <EstimateColumnHeading
                      label="Client price"
                      detail="auto + markup · ex GST"
                      title="Amount included in the client estimate. Automatically budget cost plus the default markup; click to override."
                    />
                    <EstimateColumnHeading
                      label="Actual cost"
                      detail="approved invoices · ex GST"
                      title="What RESLU has actually incurred, populated by approved supplier invoices."
                    />
                    <EstimateColumnHeading
                      label="Profit / loss"
                      detail="client − actual"
                      title="Client price less actual cost. Negative values are losses."
                    />
                    <th className="label-caps px-2 py-1.5">Status</th>
                    <th className="label-caps px-2 py-1.5">Notes</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {section.lines.map((line, lineIndex) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      measurements={measurements}
                      markupPct={estimate.markup_pct}
                      onPatch={(patch) => patchLine(line, patch)}
                      onDelete={() => deleteLine(line)}
                      quoteSummaries={estimate.quote_summaries[line.id] ?? []}
                      onOpenQuoteRequests={onOpenQuoteRequests}
                      isDragging={draggingLine?.lineId === line.id}
                      dropEdge={
                        dropTarget?.sectionId === section.id && dropTarget.lineId === line.id
                          ? dropTarget.edge
                          : null
                      }
                      reorderDisabled={reorderingSectionId !== null}
                      canMoveUp={lineIndex > 0}
                      canMoveDown={lineIndex < section.lines.length - 1}
                      onMove={(delta) => moveLine(section.id, line.id, delta)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", line.id);
                        setDraggingLine({ sectionId: section.id, lineId: line.id });
                        setDropTarget(null);
                      }}
                      onDragEnd={() => {
                        setDraggingLine(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(event) => {
                        if (draggingLine?.sectionId !== section.id || draggingLine.lineId === line.id) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        const rect = event.currentTarget.getBoundingClientRect();
                        const edge = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                        setDropTarget({ sectionId: section.id, lineId: line.id, edge });
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!draggingLine || draggingLine.sectionId !== section.id) return;
                        const edge =
                          dropTarget?.sectionId === section.id && dropTarget.lineId === line.id
                            ? dropTarget.edge
                            : "before";
                        const draggedLineId = draggingLine.lineId;
                        setDraggingLine(null);
                        setDropTarget(null);
                        reorderLine(section.id, draggedLineId, line.id, edge);
                      }}
                    />
                  ))}
                  <DraftLineRow
                    sectionId={section.id}
                    markupPct={estimate.markup_pct}
                    onAdd={(draft) => addLineDraft(section.id, draft)}
                  />
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      {/* FF&E — from schedule (Week 6, additive). Computed from the spec
          register's items, not cost lines — schedule items are never
          duplicated as cost lines (BUILD-SPEC.md "Estimate ↔ Schedule
          integration"). Sits between the trade sections and the
          "Add section" affordance, per the build brief. */}
      <FfeBlock ffe={estimate.ffe} />

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

function EstimateColumnHeading({
  label,
  detail,
  title,
}: {
  label: string;
  detail: string;
  title: string;
}) {
  return (
    <th className="w-28 px-2 py-1.5 text-right" title={title}>
      <span className="label-caps block">{label}</span>
      <span className="mt-0.5 block text-[10px] font-normal normal-case tracking-normal text-charcoal/45">
        {detail}
      </span>
    </th>
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

/**
 * Week 7 line-entry UX fix. Edits to an existing line accumulate in
 * local `draft` state as the user types/selects — nothing hits the
 * network per keystroke or per cell. A single PATCH fires on row blur
 * (focus leaving the row entirely — see onBlur/relatedTarget check
 * below) or via the explicit tick "save" button that appears once the
 * row is dirty. The row updates itself optimistically the moment the
 * PATCH is sent (so totals/summary — which read straight from
 * `estimate` in the parent — reflect the edit instantly); on failure
 * it rolls back to the last-known-good server row and shows an inline
 * error instead of the whole page erroring out.
 *
 * Link/unlink pickers (item + measurement) still act immediately on
 * selection (not part of the accumulating draft) since they're a
 * single discrete action, not a text field mid-edit — same as before.
 */
function LineRow({
  line,
  measurements,
  markupPct,
  onPatch,
  onDelete,
  isDragging,
  dropEdge,
  reorderDisabled,
  canMoveUp,
  canMoveDown,
  onMove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  quoteSummaries,
  onOpenQuoteRequests,
}: {
  line: CostLine;
  measurements: MeasurementWithGroup[];
  markupPct: number;
  onPatch: (patch: Partial<CostLine>) => Promise<CostLine>;
  onDelete: () => void;
  isDragging: boolean;
  dropEdge: "before" | "after" | null;
  reorderDisabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: -1 | 1) => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLTableRowElement>) => void;
  onDrop: (event: React.DragEvent<HTMLTableRowElement>) => void;
  quoteSummaries: EstimateResponse["quote_summaries"][string];
  onOpenQuoteRequests: () => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [measurementLinkOpen, setMeasurementLinkOpen] = useState(false);
  const [contactLinkOpen, setContactLinkOpen] = useState(false);
  const [linkedContact, setLinkedContact] = useState<Contact | null>(null);
  const [draft, setDraft] = useState<CostLine>(line);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);

  // If the server row changes underneath us (e.g. another tab, or a
  // successful save round-tripping a canonical value) and we have no
  // unsaved local edits, adopt it. While dirty, keep the user's
  // in-progress edits — don't clobber them mid-type.
  const lastLineId = useRef(line.id);
  // This guard synchronizes the local draft with a newly supplied server row.
  // eslint-disable-next-line react-hooks/refs
  if (!dirty && (lastLineId.current !== line.id || line.updated_at !== draft.updated_at)) {
    // eslint-disable-next-line react-hooks/refs
    lastLineId.current = line.id;
    if (draft.id !== line.id || draft.updated_at !== line.updated_at) {
      setDraft(line);
    }
  }

  function setField<K extends keyof CostLine>(key: K, value: CostLine[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  // Week 9 — Address Book link (BUILD-SPEC.md "Link points"): CostLine
  // only carries contact_id, so the linked contact's display name is
  // fetched separately here (a single-row GET, not a list) whenever
  // the id changes — mirrors the "resolve a linked id to a label"
  // pattern the measurement link already uses via the parent's
  // `measurements` prop, but a contact isn't preloaded in bulk since
  // most lines have no contact link.
  useEffect(() => {
    if (!draft.contact_id) {
      // Clearing a contact that was removed from the external row is part of
      // this effect's synchronization boundary.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedContact(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/contacts/${draft.contact_id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body?.contact) setLinkedContact(body.contact as Contact);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draft.contact_id]);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setRowError(null);
    const patch: Partial<CostLine> = {
      description: draft.description,
      qty: draft.qty,
      unit: draft.unit,
      rate_ex_gst: draft.rate_ex_gst,
      cost_ex_gst: draft.cost_ex_gst,
      quoted_to_client_ex_gst: draft.quoted_to_client_ex_gst,
      actual_paid_ex_gst: draft.actual_paid_ex_gst,
      quote_status: draft.quote_status,
      notes: draft.notes,
      wastage_pct: draft.wastage_pct,
    };
    try {
      const updated = await onPatch(patch);
      setDraft(updated);
      setDirty(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not save this line.");
      // Deliberately NOT reverting `draft` here — the user's typed
      // values stay on screen (nothing looks like it vanished) and
      // they can retry (tick button) or fix the value and blur again.
      // The parent's local state still holds the last-known-good
      // server row, so totals reflect reality even though this row's
      // draft is temporarily ahead of it.
    } finally {
      setSaving(false);
    }
  }

  // Immediate (non-draft) patches — link/unlink actions are a single
  // discrete click, not accumulated typing, so they save straight
  // away like before. Still routed through onPatch (optimistic +
  // rollback lives one level up in EstimateWorkspace/EstimateView).
  async function patchNow(patch: Partial<CostLine>) {
    setRowError(null);
    try {
      const updated = await onPatch(patch);
      setDraft(updated);
      setDirty(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not update this line.");
    }
  }

  function handleRowBlur(e: React.FocusEvent<HTMLTableRowElement>) {
    // Only save once focus leaves the row entirely (not when it moves
    // between two cells of the same row) — relatedTarget is the
    // element about to receive focus.
    if (rowRef.current && e.relatedTarget && rowRef.current.contains(e.relatedTarget as Node)) {
      return;
    }
    save();
  }

  const linkedMeasurement = draft.measurement_id
    ? measurements.find((m) => m.id === draft.measurement_id) ?? null
    : null;
  const cost = lineCost(draft, linkedMeasurement);
  const clientPrice = lineClientPrice(draft, markupPct, linkedMeasurement);
  const profitLoss = lineProfitLoss(draft, markupPct, linkedMeasurement);
  const qty = effectiveQty(draft, linkedMeasurement);

  return (
    <>
      <tr
        ref={rowRef}
        onBlur={handleRowBlur}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={clsx(
          "border-b border-[#e5e0d6] align-top transition-opacity",
          dirty && "bg-cream/60",
          isDragging && "opacity-35",
          dropEdge === "before" && "border-t-2 border-t-sand",
          dropEdge === "after" && "border-b-2 border-b-sand"
        )}
      >
        <td className="space-y-0.5 pt-1.5">
          <button
            type="button"
            draggable={!reorderDisabled}
            disabled={reorderDisabled}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" && canMoveUp) {
                event.preventDefault();
                onMove(-1);
              }
              if (event.key === "ArrowDown" && canMoveDown) {
                event.preventDefault();
                onMove(1);
              }
            }}
            aria-label={`Reorder ${draft.description}. Drag, or use the up and down arrow keys.`}
            title="Drag to reorder · use ↑/↓ from the keyboard"
            className="block cursor-grab px-1 text-caption leading-none text-charcoal/35 hover:text-nearblack active:cursor-grabbing disabled:cursor-wait disabled:opacity-40"
          >
            ⋮⋮
          </button>
          <button
            type="button"
            onClick={() => setLinkOpen((o) => !o)}
            title={draft.item_id ? "Linked to a spec register item" : "Link to a spec register item"}
            className={clsx(
              "block px-1 text-caption",
              draft.item_id ? "text-sand" : "text-charcoal/25 hover:text-charcoal/60"
            )}
          >
            ⚭
          </button>
          {/* Measurement link — Week 7 "Estimate ↔ Schedule integration":
              a second, distinct link affordance (📏) so the two kinds of
              linking (spec register item vs. measurement) stay visually
              and functionally separate — a line can have either, both,
              or neither. */}
          <button
            type="button"
            onClick={() => setMeasurementLinkOpen((o) => !o)}
            title={
              draft.measurement_id
                ? "Linked to a measurement — qty is computed"
                : "Link to a measurement (computes qty automatically)"
            }
            className={clsx(
              "block px-1 text-caption",
              draft.measurement_id ? "text-sand" : "text-charcoal/25 hover:text-charcoal/60"
            )}
          >
            📏
          </button>
          {/* Contact link — Week 9 "Address Book" link point: "who's
              quoting/doing the trade". A third, distinct link
              affordance so it stays visually separate from the item
              and measurement links above — a line can carry any
              combination of the three independently. */}
          <button
            type="button"
            onClick={() => setContactLinkOpen((o) => !o)}
            title={draft.contact_id ? "Linked to an Address Book contact" : "Link to an Address Book contact"}
            className={clsx(
              "block px-1 text-caption",
              draft.contact_id ? "text-sand" : "text-charcoal/25 hover:text-charcoal/60"
            )}
          >
            ☏
          </button>
          {dirty && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()} // keep row focus so handleRowBlur doesn't double-fire
              onClick={save}
              disabled={saving}
              title="Save this line"
              aria-label="Save this line"
              className="block px-1 text-caption text-sand hover:text-nearblack disabled:opacity-50"
            >
              {saving ? "…" : "✓"}
            </button>
          )}
        </td>
        <td className="min-w-[220px] px-0 py-0">
          <EditableText
            value={draft.description}
            onCommit={(v) => v && setField("description", v)}
          />
          {draft.line_kind === "delivery_allowance" && (
            <p className="px-2 pb-1 text-caption text-sand">
              Delivery allowance · project cost only · no catalogue price
            </p>
          )}
          {/* Double-counting rule (BUILD-SPEC.md "Estimate ↔ Schedule
              integration"): a line linked to a spec register item means
              this line is labour/install only — the product's own cost
              is already captured in the FF&E block below, sourced from
              the item's price_trade/price_rrp. Showing both here would
              double-count the product cost. */}
          {draft.item_id && (
            <p className="px-2 pb-1 text-caption text-sand">
              Labour/install only — product cost in schedule
            </p>
          )}
          {/* Address Book chip — BUILD-SPEC.md "Link points": "selecting
              also autofills the line's notes? NO — just stores the link
              and shows company name chip." */}
          {linkedContact && (
            <p className="px-2 pb-1">
              <span className="label-caps inline-block border border-sand px-1.5 py-0.5 !text-sand">
                {linkedContact.company}
              </span>
            </p>
          )}
          {quoteSummaries.map((summary) => (
            <button key={summary.package_id} type="button" onClick={onOpenQuoteRequests} className="mx-2 mb-1 block border border-sand px-1.5 py-0.5 text-left text-caption text-sand hover:bg-cream">
              Quotes {summary.received_count}/{summary.request_count} · {summary.package_title}{summary.next_due ? ` · due ${summary.next_due}` : ""}
            </button>
          ))}
          {rowError && <p className="px-2 pb-1 text-caption text-red-700">⚠ {rowError}</p>}
        </td>
        <td className="w-24 px-0 py-0">
          {draft.measurement_id ? (
            <div className="px-2 py-1.5">
              <p className="text-right text-body text-nearblack">
                {qty !== null ? qty : "—"}
              </p>
              <p className="text-right text-caption text-sand">
                linked{draft.wastage_pct ? ` · +${draft.wastage_pct}% wastage` : ""}
              </p>
              <input
                type="number"
                min="0"
                max="50"
                step="0.1"
                value={draft.wastage_pct ?? ""}
                placeholder="Wastage %"
                onChange={(e) => {
                  const v = e.target.value;
                  setField("wastage_pct", v === "" ? null : Number(v));
                }}
                title="Wastage % (0–50), applied on top of the linked measurement's value"
                className="mt-1 w-full border border-[#c9c2b4] bg-nearwhite px-1.5 py-1 text-right text-caption text-charcoal focus:border-nearblack focus:outline-none"
              />
            </div>
          ) : (
            <EditableNumber
              value={draft.qty}
              onCommit={(v) => setField("qty", v)}
            />
          )}
        </td>
        <td className="w-20 px-0 py-0">
          <EditableText value={draft.unit} onCommit={(v) => setField("unit", v || null)} />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber value={draft.rate_ex_gst} onCommit={(v) => setField("rate_ex_gst", v)} />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber
            value={draft.cost_ex_gst === 0 && cost !== 0 ? null : draft.cost_ex_gst}
            placeholder={cost !== null ? formatMoney(cost) : "—"}
            onCommit={(v) => setField("cost_ex_gst", v)}
          />
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber
            value={draft.quoted_to_client_ex_gst}
            placeholder={
              clientPrice !== null ? `Auto ${formatMoney(clientPrice)}` : "—"
            }
            onCommit={(v) => setField("quoted_to_client_ex_gst", v)}
          />
          {draft.line_kind === "delivery_allowance" && (
            <p className="px-2 pb-1 text-right text-[10px] text-charcoal/45">Delivery allowance</p>
          )}
        </td>
        <td className="w-28 px-0 py-0">
          <EditableNumber
            value={draft.actual_paid_ex_gst}
            onCommit={(v) => setField("actual_paid_ex_gst", v)}
          />
          {draft.line_kind === "delivery_allowance" && (
            <p className="px-2 pb-1 text-right text-[10px] text-charcoal/45">Actual delivery</p>
          )}
        </td>
        <td
          className={clsx(
            "w-24 px-2 py-1.5 text-right text-body",
            profitLoss !== null && profitLoss < 0 && "text-red-700",
            profitLoss !== null && profitLoss > 0 && "text-green-800"
          )}
        >
          {draft.line_kind === "delivery_allowance" && (
            <span className="block text-[10px] text-charcoal/45">Delivery variance</span>
          )}
          {profitLoss !== null ? formatMoney(profitLoss) : "—"}
        </td>
        <td className="px-1 py-1">
          <select
            value={draft.quote_status ?? ""}
            onChange={(e) => setField("quote_status", (e.target.value || null) as CostLine["quote_status"])}
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
          <EditableText value={draft.notes} onCommit={(v) => setField("notes", v || null)} />
        </td>
        <td className="px-1 py-1.5">
          <button
            type="button"
            onClick={() => {
              if (confirm(`Remove line "${draft.description}"?`)) onDelete();
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
              projectId={draft.project_id}
              currentItemId={draft.item_id}
              onSelect={(itemId) => {
                patchNow({ item_id: itemId });
                setLinkOpen(false);
              }}
              onClose={() => setLinkOpen(false)}
            />
          </td>
        </tr>
      )}
      {measurementLinkOpen && (
        <tr className="border-b border-[#e5e0d6] bg-offwhite">
          <td />
          <td colSpan={11} className="px-2 py-3">
            <MeasurementLinkPicker
              measurements={measurements}
              currentMeasurementId={draft.measurement_id}
              onSelect={(measurementId) => {
                // Unlinking clears wastage_pct too — it's meaningless
                // without a linked measurement, and leaving a stale
                // value behind would be confusing if the same line is
                // relinked to a different measurement later.
                patchNow({
                  measurement_id: measurementId,
                  ...(measurementId ? {} : { wastage_pct: null }),
                });
                setMeasurementLinkOpen(false);
              }}
              onClose={() => setMeasurementLinkOpen(false)}
            />
          </td>
        </tr>
      )}
      {contactLinkOpen && (
        <tr className="border-b border-[#e5e0d6] bg-offwhite">
          <td />
          <td colSpan={11} className="px-2 py-3">
            <ContactLinkPicker
              currentContactId={draft.contact_id}
              onSelect={(contactId) => {
                patchNow({ contact_id: contactId });
                setContactLinkOpen(false);
              }}
              onClose={() => setContactLinkOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * New-line draft row (Week 7 line-entry UX fix) — sits at the bottom
 * of each section's table, mirroring components/items/SpecRegister.tsx's
 * AddItemForm rapid-entry pattern: fill the row's fields, Enter (in any
 * text/number field) or the "Add" button posts the WHOLE line in one
 * request, then the row clears and refocuses its first field so a user
 * entering many lines in a row never leaves the keyboard.
 */
type NewLineDraft = {
  description: string;
  qty: string;
  unit: string;
  rate_ex_gst: string;
  quoted_to_client_ex_gst: string;
  actual_paid_ex_gst: string;
  quote_status: QuoteStatus | "";
};

// The numeric, API-ready shape DraftLineRow produces from the string
// form draft above — what addLineDraft posts to the lines endpoint.
type NewLineInput = {
  description: string;
  qty?: number | null;
  unit?: string | null;
  rate_ex_gst?: number | null;
  quoted_to_client_ex_gst?: number | null;
  actual_paid_ex_gst?: number | null;
  quote_status?: QuoteStatus | null;
};

const BLANK_DRAFT: NewLineDraft = {
  description: "",
  qty: "",
  unit: "",
  rate_ex_gst: "",
  quoted_to_client_ex_gst: "",
  actual_paid_ex_gst: "",
  quote_status: "",
};

function DraftLineRow({
  sectionId,
  markupPct,
  onAdd,
}: {
  sectionId: string;
  markupPct: number;
  onAdd: (draft: NewLineInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<NewLineDraft>(BLANK_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descRef = useRef<HTMLInputElement>(null);

  function setField<K extends keyof NewLineDraft>(key: K, value: NewLineDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function submit() {
    if (!draft.description.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd({
        description: draft.description.trim(),
        qty: draft.qty === "" ? null : Number(draft.qty),
        unit: draft.unit.trim() || null,
        rate_ex_gst: draft.rate_ex_gst === "" ? null : Number(draft.rate_ex_gst),
        quoted_to_client_ex_gst:
          draft.quoted_to_client_ex_gst === "" ? null : Number(draft.quoted_to_client_ex_gst),
        actual_paid_ex_gst: draft.actual_paid_ex_gst === "" ? null : Number(draft.actual_paid_ex_gst),
        quote_status: draft.quote_status || null,
      });
      setDraft(BLANK_DRAFT);
      descRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add line.");
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

  const draftQty = draft.qty === "" ? null : Number(draft.qty);
  const draftRate = draft.rate_ex_gst === "" ? null : Number(draft.rate_ex_gst);
  const automaticClientPrice =
    draftQty !== null &&
    draftRate !== null &&
    Number.isFinite(draftQty) &&
    Number.isFinite(draftRate)
      ? lineClientPrice(
          {
            qty: draftQty,
            rate_ex_gst: draftRate,
            cost_ex_gst: null,
            measurement_id: null,
            wastage_pct: null,
            quoted_to_client_ex_gst: null,
          },
          markupPct
        )
      : null;

  return (
    <tr id={`draft-line-${sectionId}`} className="border-b border-[#e5e0d6] bg-offwhite/60 align-top">
      <td />
      <td className="min-w-[220px] px-0 py-0">
        <input
          ref={descRef}
          value={draft.description}
          onChange={(e) => setField("description", e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="+ Add line — description"
          className="w-full border-none bg-transparent px-2 py-1.5 text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
        {error && <p className="px-2 pb-1 text-caption text-red-700">⚠ {error}</p>}
      </td>
      <td className="w-24 px-0 py-0">
        <input
          type="number"
          step="any"
          value={draft.qty}
          onChange={(e) => setField("qty", e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Qty"
          className="w-full border-none bg-transparent px-2 py-1.5 text-right text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="w-20 px-0 py-0">
        <input
          value={draft.unit}
          onChange={(e) => setField("unit", e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Unit"
          className="w-full border-none bg-transparent px-2 py-1.5 text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="w-28 px-0 py-0">
        <input
          type="number"
          step="any"
          value={draft.rate_ex_gst}
          onChange={(e) => setField("rate_ex_gst", e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Rate"
          className="w-full border-none bg-transparent px-2 py-1.5 text-right text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="w-28 px-0 py-0">
        <p className="px-2 py-1.5 text-right text-caption text-charcoal/30">computed</p>
      </td>
      <td className="w-28 px-0 py-0">
        <input
          type="number"
          step="any"
          value={draft.quoted_to_client_ex_gst}
          onChange={(e) => setField("quoted_to_client_ex_gst", e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            automaticClientPrice !== null
              ? `Auto ${formatMoney(automaticClientPrice)}`
              : "Auto client price"
          }
          className="w-full border-none bg-transparent px-2 py-1.5 text-right text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td className="w-28 px-0 py-0">
        <input
          type="number"
          step="any"
          value={draft.actual_paid_ex_gst}
          onChange={(e) => setField("actual_paid_ex_gst", e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Actual"
          className="w-full border-none bg-transparent px-2 py-1.5 text-right text-body text-charcoal placeholder:text-charcoal/35 focus:outline-none focus:bg-nearwhite"
        />
      </td>
      <td />
      <td className="px-1 py-1">
        <select
          value={draft.quote_status}
          onChange={(e) => setField("quote_status", e.target.value as QuoteStatus | "")}
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
      <td />
      <td className="px-1 py-1.5">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !draft.description.trim()}
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

/**
 * FF&E — from schedule block. Per-category rows (category, item count,
 * total, confidence badge) plus an overall "FF&E $X — Y% quoted / Z%
 * placeholder" line. Read-only here — the underlying numbers come from
 * the spec register's items (price_trade/price_rrp/quantity), which are
 * edited in the Pricing & Procurement view, not this tab.
 */
function FfeBlock({ ffe }: { ffe: EstimateResponse["ffe"] }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <section className="border border-[#dcd6cc]">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-cream px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-charcoal/50 hover:text-nearblack"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "−" : "+"}
          </button>
          <p className="label-caps !text-nearblack">FF&E — from schedule</p>
        </div>
        <span className="text-caption text-charcoal/50">
          Product cost from the spec register — priced separately from the trade estimate above
        </span>
      </div>

      {expanded && (
        <div className="overflow-x-auto">
          {ffe.categories.length === 0 ? (
            <p className="px-4 py-6 text-body text-charcoal/40">
              No priced items on the spec register yet.
            </p>
          ) : (
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr className="border-b border-[#dcd6cc] text-left">
                  <th className="label-caps px-2 py-1.5">Category</th>
                  <th className="label-caps px-2 py-1.5 text-right">Items</th>
                  <th className="label-caps px-2 py-1.5 text-right">Product cost ex GST</th>
                  <th className="label-caps px-2 py-1.5 text-right">Client quote ex GST</th>
                  <th className="label-caps px-2 py-1.5">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {ffe.categories.map((cat) => (
                  <tr key={cat.category} className="border-b border-[#e5e0d6]">
                    <td className="px-2 py-1.5 text-body text-nearblack">
                      {cat.category}
                      {(cat as { category_name?: string }).category_name ? (
                        <span className="text-charcoal/60">
                          {" — "}
                          {(cat as { category_name?: string }).category_name}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-right text-body">{cat.item_count}</td>
                    <td className="px-2 py-1.5 text-right text-body">{formatMoney(cat.total)}</td>
                    <td className="px-2 py-1.5 text-right text-body">{formatMoney(cat.client_total)}</td>
                    <td className="px-2 py-1.5">
                      <FfeConfidenceBadges cat={cat} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="border-t border-[#dcd6cc] px-4 py-3">
            <p className="text-body text-nearblack">
              FF&amp;E client quote {formatMoney(ffe.client_total)} · product cost {formatMoney(ffe.total)} —{" "}
              {ffe.quoted_count} quoted · {ffe.placeholder_count}{" "}
              {ffe.placeholder_count === 1 ? "RRP placeholder" : "RRP placeholders"}
              {ffe.unpriced_count > 0 && (
                <span className="text-charcoal/50"> · {ffe.unpriced_count} unpriced</span>
              )}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Per-row confidence badges: 'QUOTED' (sand — price_trade set on at
 * least one item), 'RRP PLACEHOLDER' (muted — falling back to
 * price_rrp), 'UNPRICED n items' (warning — neither price set). A
 * category can show more than one badge if it has a mix.
 */
function FfeConfidenceBadges({ cat }: { cat: FfeCategoryRollup }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {cat.quoted_count > 0 && (
        <span className="label-caps border border-sand px-1.5 py-0.5 !text-sand">
          Quoted{cat.quoted_count > 1 ? ` (${cat.quoted_count})` : ""}
        </span>
      )}
      {cat.placeholder_count > 0 && (
        <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
          RRP placeholder{cat.placeholder_count > 1 ? ` (${cat.placeholder_count})` : ""}
        </span>
      )}
      {cat.unpriced_count > 0 && (
        <span className="label-caps border border-red-700/40 px-1.5 py-0.5 !text-red-700">
          Unpriced {cat.unpriced_count} {cat.unpriced_count === 1 ? "item" : "items"}
        </span>
      )}
    </div>
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
