"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { CostSectionWithLines, InvoiceMatchType, InvoiceStatus, Item } from "@/types";
import type {
  InvoiceAllocation,
  InvoiceWithAllocations,
} from "@/types/round-supplier-invoice-intake";
import type { InvoiceAllocationInput } from "@/lib/invoice-allocations";
import { invoiceAllocationBalance } from "@/lib/invoice-allocations";
import { formatMoney } from "@/components/estimate/EstimateWorkspace";

const STATUS_TABS: { value: InvoiceStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unmatched", label: "Unmatched" },
  { value: "proposed", label: "Proposed" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  unmatched: "border-[#c9c2b4] text-charcoal/60",
  proposed: "border-sand text-sand",
  approved: "border-nearblack bg-nearblack text-white",
  rejected: "border-red-700/40 text-red-700",
};

interface Props {
  projectId: string;
}

/**
 * /projects/[id]/invoices — the Invoice queue (admin-only, financial).
 * BUILD-SPEC.md "Invoice pipeline — AI-updated actuals": queue table
 * (supplier, inv#, date, amount, status chip, proposed match), row
 * expand → set/change match, approve/reject buttons, upload form.
 *
 * Server-truth-first: approve/reject/match calls await the API
 * response and refresh from it rather than only patching local state,
 * since these are real money writes (BUILD-SPEC.md "no silent money
 * writes") — an optimistic-only update here would risk showing a
 * status the server actually rejected (e.g. approving twice).
 */
export function InvoiceQueue({ projectId }: Props) {
  const [invoices, setInvoices] = useState<InvoiceWithAllocations[]>([]);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const res = await fetch(`/api/projects/${projectId}/invoices${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load invoices.");
      setInvoices(body.invoices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load invoices.");
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

  useEffect(() => {
    // Initial/filter-triggered network load; state updates happen after
    // the awaited request inside load(), not as derived render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /**
   * Booking selection v2 + Aria supplier invoices (r24), item 7:
   * `applyToLibraryCost` is the per-line "update the linked library
   * product's cost record" toggle (MatchedItemLibraryToggle below) —
   * omitted (undefined) lets the server apply its own default (ON when
   * the matched item carries a library_item_id, per POST
   * /api/invoices/[id]/approve's own doc comment); passed explicitly
   * once the admin has touched the checkbox in the expanded row.
   */
  async function approve(id: string, applyToLibraryCost?: boolean) {
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applyToLibraryCost === undefined ? {} : { apply_to_library_cost: applyToLibraryCost }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not approve invoice.");
      if (body.warning) setError(body.warning);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve invoice.");
    }
  }

  /** r24 — "review extracted fields + matches (editable)": PATCHes the canonical fields via the existing PATCH /api/invoices/[id] route (unchanged this round, already accepts these). */
  async function saveFields(id: string, patch: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save changes.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes.");
    }
  }

  async function reject(id: string) {
    if (!confirm("Reject this invoice? It can be resubmitted later if needed.")) return;
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}/reject`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not reject invoice.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reject invoice.");
    }
  }

  async function saveAllocations(id: string, allocations: InvoiceAllocationInput[]) {
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocations }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save allocations.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save allocations.");
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <UploadForm projectId={projectId} onCreated={load} onError={setError} />

      <div className="flex border border-[#c9c2b4]">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setStatusFilter(t.value)}
            className={clsx(
              "px-4 py-2 text-subhead transition-colors",
              statusFilter === t.value ? "bg-nearblack text-white" : "text-charcoal hover:bg-nearwhite"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-body text-charcoal/50">Loading invoices…</p>
      ) : invoices.length === 0 ? (
        <p className="border border-dashed border-[#c9c2b4] p-8 text-center text-body text-charcoal/50">
          No invoices in this queue.
        </p>
      ) : (
        <div className="overflow-x-auto border border-[#dcd6cc]">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="border-b border-[#dcd6cc] bg-cream text-left">
                <th className="w-6" />
                <th className="label-caps px-2 py-1.5">Supplier</th>
                <th className="label-caps px-2 py-1.5">Invoice #</th>
                <th className="label-caps px-2 py-1.5">Date</th>
                <th className="label-caps px-2 py-1.5 text-right">Amount ex GST</th>
                <th className="label-caps px-2 py-1.5">Status</th>
                <th className="label-caps px-2 py-1.5">Match</th>
                <th className="label-caps px-2 py-1.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  projectId={projectId}
                  expanded={expandedId === inv.id}
                  onToggle={() => setExpandedId((cur) => (cur === inv.id ? null : inv.id))}
                  onApprove={(applyToLibraryCost) => approve(inv.id, applyToLibraryCost)}
                  onReject={() => reject(inv.id)}
                  onSaveAllocations={(allocations) => saveAllocations(inv.id, allocations)}
                  onSaveFields={(patch) => saveFields(inv.id, patch)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  projectId,
  expanded,
  onToggle,
  onApprove,
  onReject,
  onSaveAllocations,
  onSaveFields,
}: {
  invoice: InvoiceWithAllocations;
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
  onApprove: (applyToLibraryCost?: boolean) => void;
  onReject: () => void;
  onSaveAllocations: (allocations: InvoiceAllocationInput[]) => void;
  onSaveFields: (patch: Record<string, unknown>) => void;
}) {
  const editable = invoice.status !== "approved" && invoice.status !== "rejected";
  const savedAllocations = invoice.invoice_allocations ?? [];
  const hasSavedAllocations = savedAllocations.length > 0;
  const hasLegacyMatch = Boolean(invoice.proposed_match_type && invoice.proposed_match_id);
  const canApprove = hasSavedAllocations || hasLegacyMatch;
  // r24 item 7's per-line toggle — undefined means "let the server pick
  // its own default" (see POST /api/invoices/[id]/approve's own doc
  // comment); starts checked so the UI's own default reads as ON,
  // matching the server's stated default.
  const [applyToLibraryCost, setApplyToLibraryCost] = useState(true);
  const [editingFields, setEditingFields] = useState(false);
  const [fieldDrafts, setFieldDrafts] = useState({
    supplier: invoice.supplier,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date ?? "",
    amount_ex_gst: String(invoice.amount_ex_gst),
  });
  // r24 — "Aria · needs approval": source='aria' AND not yet in a
  // terminal state (migration 052's own comment on invoices.source is
  // the single source of truth for this derivation — kept in sync with
  // it here rather than adding a server-computed flag for one pill).
  const needsAriaApproval = invoice.source === "aria" && editable;

  function saveFieldEdits() {
    const amountNum = Number(fieldDrafts.amount_ex_gst);
    if (!fieldDrafts.supplier.trim() || !fieldDrafts.invoice_number.trim() || !Number.isFinite(amountNum)) return;
    onSaveFields({
      supplier: fieldDrafts.supplier.trim(),
      invoice_number: fieldDrafts.invoice_number.trim(),
      invoice_date: fieldDrafts.invoice_date || null,
      amount_ex_gst: amountNum,
    });
    setEditingFields(false);
  }

  return (
    <>
      <tr className="border-b border-[#e5e0d6] align-top">
        <td className="pt-1.5">
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="px-1 py-1 text-charcoal/50 hover:text-nearblack"
          >
            {expanded ? "−" : "+"}
          </button>
        </td>
        <td className="px-2 py-1.5 text-body text-nearblack">{invoice.supplier}</td>
        <td className="px-2 py-1.5 text-body">{invoice.invoice_number}</td>
        <td className="px-2 py-1.5 text-body text-charcoal/70">
          {invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString("en-AU") : "—"}
        </td>
        <td className="px-2 py-1.5 text-right text-body">{formatMoney(invoice.amount_ex_gst)}</td>
        <td className="px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className={clsx("label-caps border px-1.5 py-0.5", STATUS_STYLES[invoice.status])}>
              {invoice.status}
            </span>
            {/* r24 item 6: "Aria · needs approval" sand/amber pill — same
                amber tone as the board's other trade-proposed-a-change
                badge (components/board/ProjectBoard.tsx's "Date
                suggested" chip), for a consistent "something needs your
                eyes" visual language across the app. */}
            {needsAriaApproval && (
              <span
                title="Drafted by Aria from an incoming supplier email — review the extracted fields and match below before approving."
                className="label-caps border border-amber-700/40 bg-amber-50 px-1.5 py-0.5 !text-amber-800"
              >
                Aria · needs approval
              </span>
            )}
          </div>
        </td>
        <td className="px-2 py-1.5 text-caption text-charcoal/60">
          {hasSavedAllocations
            ? `${savedAllocations.length} allocation${savedAllocations.length === 1 ? "" : "s"}`
            : invoice.proposed_match_type
            ? `${invoice.proposed_match_type === "cost_line" ? "Cost line" : "Item"} linked`
            : "No match"}
        </td>
        <td className="px-2 py-1.5">
          <div className="flex gap-2">
            {editable && (
              <>
                <button
                  type="button"
                  disabled={!canApprove}
                  title={!canApprove ? "Save allocations before approving" : undefined}
                  onClick={() => onApprove(hasSavedAllocations ? undefined : applyToLibraryCost)}
                  className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                >
                  Approve & apply
                </button>
                <button
                  type="button"
                  onClick={onReject}
                  className="border border-red-700/40 px-2 py-1 text-caption text-red-700 hover:bg-red-700 hover:text-white"
                >
                  Reject
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[#e5e0d6] bg-offwhite">
          <td />
          <td colSpan={7} className="px-2 py-3">
            <div className="space-y-3">
              {invoice.confidence_note && (
                <p className="text-caption text-charcoal/60">
                  <span className="label-caps mr-1 !text-charcoal/50">Note:</span>
                  {invoice.confidence_note}
                </p>
              )}

              {/* r24 item 5/6: Aria's raw extraction, shown read-only as
                  context — the canonical fields (supplier/invoice_number/
                  invoice_date/amount_ex_gst, editable just below) are
                  what Approve actually applies; this is "what she read
                  off the PDF", useful for spotting an extraction miss. */}
              {invoice.source === "aria" && invoice.extracted && (
                <div className="space-y-1 border border-amber-700/30 bg-amber-50/60 px-3 py-2">
                  <p className="label-caps !text-amber-800">Aria&apos;s extraction</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-caption text-charcoal/70 sm:grid-cols-4">
                    {invoice.extracted.abn && (
                      <div>
                        <dt className="text-charcoal/40">ABN</dt>
                        <dd>{invoice.extracted.abn}</dd>
                      </div>
                    )}
                    {invoice.extracted.total_inc_gst !== undefined && (
                      <div>
                        <dt className="text-charcoal/40">Total inc GST</dt>
                        <dd>{formatMoney(invoice.extracted.total_inc_gst)}</dd>
                      </div>
                    )}
                    {invoice.extracted.line_hints && (
                      <div className="col-span-2 sm:col-span-4">
                        <dt className="text-charcoal/40">Line hints</dt>
                        <dd>{invoice.extracted.line_hints}</dd>
                      </div>
                    )}
                    {invoice.extracted.job_hints && (
                      <div className="col-span-2 sm:col-span-4">
                        <dt className="text-charcoal/40">Job hints</dt>
                        <dd>{invoice.extracted.job_hints}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}

              {/* r24 item 6: "review extracted fields ... editable". */}
              <div className="space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
                <div className="flex items-center justify-between">
                  <p className="label-caps">Invoice fields</p>
                  {editable && !editingFields && (
                    <button
                      type="button"
                      onClick={() => setEditingFields(true)}
                      className="text-caption text-charcoal/50 underline hover:text-nearblack"
                    >
                      Edit
                    </button>
                  )}
                </div>
                {editingFields ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <label className="block">
                        <span className="label-caps mb-1 block !text-charcoal/50">Supplier</span>
                        <input
                          value={fieldDrafts.supplier}
                          onChange={(e) => setFieldDrafts((d) => ({ ...d, supplier: e.target.value }))}
                          className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="label-caps mb-1 block !text-charcoal/50">Invoice #</span>
                        <input
                          value={fieldDrafts.invoice_number}
                          onChange={(e) => setFieldDrafts((d) => ({ ...d, invoice_number: e.target.value }))}
                          className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="label-caps mb-1 block !text-charcoal/50">Date</span>
                        <input
                          type="date"
                          value={fieldDrafts.invoice_date}
                          onChange={(e) => setFieldDrafts((d) => ({ ...d, invoice_date: e.target.value }))}
                          className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="label-caps mb-1 block !text-charcoal/50">Amount ex GST</span>
                        <input
                          type="number"
                          step="0.01"
                          value={fieldDrafts.amount_ex_gst}
                          onChange={(e) => setFieldDrafts((d) => ({ ...d, amount_ex_gst: e.target.value }))}
                          className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none"
                        />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={saveFieldEdits}
                        className="border border-nearblack px-3 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingFields(false)}
                        className="text-caption text-charcoal/50 hover:text-nearblack"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-caption text-charcoal/60">
                    {invoice.supplier} · #{invoice.invoice_number}
                    {invoice.invoice_date ? ` · ${new Date(invoice.invoice_date).toLocaleDateString("en-AU")}` : ""} ·{" "}
                    {formatMoney(invoice.amount_ex_gst)} ex GST
                  </p>
                )}
              </div>

              {editable && !hasSavedAllocations && invoice.proposed_match_type && (
                <label className="flex items-start gap-2 text-caption text-charcoal/70">
                  <input
                    type="checkbox"
                    checked={applyToLibraryCost}
                    onChange={(e) => setApplyToLibraryCost(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span>
                    On approve, also update the matched item&apos;s linked library product&apos;s cost (so future
                    quotes use this real price) — only applies when the matched item is linked to a library product;
                    otherwise this is a no-op.
                  </span>
                </label>
              )}

              {invoice.library_cost_applied && (
                <p className="text-caption text-charcoal/50">Library product cost was updated from this invoice.</p>
              )}

              <AllocationEditor
                key={`${invoice.id}:${invoice.updated_at}:${savedAllocations
                  .map((allocation) => allocation.updated_at)
                  .join(",")}`}
                projectId={projectId}
                invoiceAmountExGst={invoice.amount_ex_gst}
                savedAllocations={savedAllocations}
                legacyMatch={
                  invoice.proposed_match_type && invoice.proposed_match_id
                    ? {
                        match_type: invoice.proposed_match_type,
                        match_id: invoice.proposed_match_id,
                        amount_ex_gst: invoice.amount_ex_gst,
                        apply_to_library_cost: false,
                      }
                    : null
                }
                disabled={invoice.status === "approved" || invoice.status === "rejected"}
                onSave={onSaveAllocations}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

interface AllocationDraft {
  key: string;
  match_type: InvoiceMatchType;
  match_id: string;
  amount: string;
  apply_to_library_cost: boolean;
}

function allocationDrafts(
  saved: InvoiceAllocation[],
  legacyMatch: InvoiceAllocationInput | null
): AllocationDraft[] {
  const source = saved.length > 0 ? saved : legacyMatch ? [legacyMatch] : [];
  return source.map((allocation, index) => ({
    key: "id" in allocation ? String(allocation.id) : `legacy-${index}`,
    match_type: allocation.match_type,
    match_id: allocation.match_id,
    amount: String(allocation.amount_ex_gst),
    apply_to_library_cost: allocation.apply_to_library_cost === true,
  }));
}

/** Exact-cent, multi-line allocation editor. A draft cannot be saved
 * until every ex-GST cent has a real project target. */
function AllocationEditor({
  projectId,
  invoiceAmountExGst,
  savedAllocations,
  legacyMatch,
  disabled,
  onSave,
}: {
  projectId: string;
  invoiceAmountExGst: number;
  savedAllocations: InvoiceAllocation[];
  legacyMatch: InvoiceAllocationInput | null;
  disabled: boolean;
  onSave: (allocations: InvoiceAllocationInput[]) => void;
}) {
  const [drafts, setDrafts] = useState<AllocationDraft[]>(() =>
    allocationDrafts(savedAllocations, legacyMatch)
  );
  const [sections, setSections] = useState<CostSectionWithLines[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/projects/${projectId}/estimate`).then((r) => (r.ok ? r.json() : { sections: [] })),
      fetch(`/api/projects/${projectId}/items`).then((r) => (r.ok ? r.json() : { items: [] })),
    ])
      .then(([estimateBody, itemsBody]) => {
        if (cancelled) return;
        setSections(estimateBody.sections ?? []);
        setItems(itemsBody.items ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const numericDrafts = drafts.map((draft) => ({ amount_ex_gst: Number(draft.amount) || 0 }));
  const balance = invoiceAllocationBalance(invoiceAmountExGst, numericDrafts);
  const complete =
    drafts.length > 0 &&
    drafts.every((draft) => draft.match_id && Number(draft.amount) > 0) &&
    balance === 0;

  function updateDraft(key: string, patch: Partial<AllocationDraft>) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  function addAllocation() {
    const remaining = invoiceAllocationBalance(
      invoiceAmountExGst,
      drafts.map((draft) => ({ amount_ex_gst: Number(draft.amount) || 0 }))
    );
    setDrafts((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        match_type: "cost_line",
        match_id: "",
        amount: remaining > 0 ? remaining.toFixed(2) : "",
        apply_to_library_cost: false,
      },
    ]);
  }

  function save() {
    if (!complete) return;
    onSave(
      drafts.map((draft) => ({
        match_type: draft.match_type,
        match_id: draft.match_id,
        amount_ex_gst: Number(draft.amount),
        apply_to_library_cost: draft.apply_to_library_cost,
      }))
    );
  }

  return (
    <div className="max-w-4xl space-y-3 border border-[#dcd6cc] bg-nearwhite p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="label-caps">Invoice allocation</p>
          <p className="text-caption text-charcoal/50">
            Split the full {formatMoney(invoiceAmountExGst)} ex GST across the estimate or specification.
          </p>
        </div>
        <span
          className={clsx(
            "label-caps border px-2 py-1",
            balance === 0
              ? "border-green-700/30 bg-green-50 !text-green-800"
              : "border-amber-700/30 bg-amber-50 !text-amber-800"
          )}
        >
          {balance === 0
            ? "Fully allocated"
            : balance > 0
              ? `${formatMoney(balance)} remaining`
              : `${formatMoney(Math.abs(balance))} over`}
        </span>
      </div>

      {loading ? (
        <p className="text-caption text-charcoal/50">Loading project costs…</p>
      ) : drafts.length === 0 ? (
        <p className="border border-dashed border-[#c9c2b4] px-3 py-4 text-center text-caption text-charcoal/50">
          No allocations saved. Add a line before approval.
        </p>
      ) : (
        <div className="space-y-2">
          {drafts.map((draft, index) => (
            <div
              key={draft.key}
              className="grid grid-cols-1 gap-2 border border-[#e5e0d6] bg-cream p-2 md:grid-cols-[minmax(0,1fr)_130px_auto_auto] md:items-center"
            >
              <label>
                <span className="sr-only">Allocation {index + 1} match</span>
                <select
                  disabled={disabled}
                  value={draft.match_id ? `${draft.match_type}:${draft.match_id}` : ""}
                  onChange={(event) => {
                    const [matchType, matchId] = event.target.value.split(":");
                    updateDraft(draft.key, {
                      match_type: (matchType || "cost_line") as InvoiceMatchType,
                      match_id: matchId ?? "",
                    });
                  }}
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                >
                  <option value="">Choose a cost line or item…</option>
                  {sections.map((section) => (
                    <optgroup key={section.id} label={`Estimate · ${section.name}`}>
                      {section.lines.map((line) => (
                        <option key={line.id} value={`cost_line:${line.id}`}>
                          {line.description}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {items.length > 0 && (
                    <optgroup label="Specification items">
                      {items.map((item) => (
                        <option key={item.id} value={`item:${item.id}`}>
                          {item.item_code} — {item.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>

              <label>
                <span className="sr-only">Allocation {index + 1} ex-GST amount</span>
                <input
                  disabled={disabled}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={draft.amount}
                  onChange={(event) => updateDraft(draft.key, { amount: event.target.value })}
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-right text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                  aria-label={`Allocation ${index + 1} amount ex GST`}
                />
              </label>

              <label className="flex items-center gap-1.5 text-caption text-charcoal/60">
                <input
                  disabled={disabled}
                  type="checkbox"
                  checked={draft.apply_to_library_cost}
                  onChange={(event) =>
                    updateDraft(draft.key, { apply_to_library_cost: event.target.checked })
                  }
                />
                Update library price
              </label>

              {!disabled && (
                <button
                  type="button"
                  onClick={() => setDrafts((current) => current.filter((row) => row.key !== draft.key))}
                  className="text-caption text-red-700 hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={addAllocation}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
          >
            + Add allocation
          </button>
          <button
            type="button"
            disabled={!complete}
            onClick={save}
            className="border border-nearblack bg-nearblack px-3 py-1.5 text-caption text-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            Save allocations
          </button>
          {savedAllocations.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (confirm("Clear every saved allocation from this invoice?")) onSave([]);
              }}
              className="text-caption text-charcoal/50 hover:text-red-700"
            >
              Clear saved allocations
            </button>
          )}
        </div>
      )}

      {!disabled && !complete && drafts.length > 0 && (
        <p className="text-caption text-amber-800">
          Approval stays locked until every line has a match and the remaining balance is $0.00.
        </p>
      )}
    </div>
  );
}

function UploadForm({
  projectId,
  onCreated,
  onError,
}: {
  projectId: string;
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountNum = Number(amount);
    if (!supplier.trim() || !invoiceNumber.trim() || !Number.isFinite(amountNum)) {
      onError("Supplier, invoice number and a valid amount are required.");
      return;
    }
    setSubmitting(true);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("supplier", supplier.trim());
      fd.append("invoice_number", invoiceNumber.trim());
      if (invoiceDate) fd.append("invoice_date", invoiceDate);
      fd.append("amount_ex_gst", String(amountNum));
      const file = fileInput.current?.files?.[0];
      if (file) fd.append("file", file);

      const res = await fetch(`/api/projects/${projectId}/invoices`, {
        method: "POST",
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not create invoice.");
      if (body.duplicate_warning) {
        onError(
          `Warning: a non-rejected invoice already exists for ${supplier.trim()} #${invoiceNumber.trim()} — both are now in the queue for review.`
        );
      }
      setSupplier("");
      setInvoiceNumber("");
      setInvoiceDate("");
      setAmount("");
      if (fileInput.current) fileInput.current.value = "";
      setOpen(false);
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create invoice.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
      >
        + Add invoice
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex items-center justify-between">
        <p className="label-caps">New invoice</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-caption text-charcoal/50 hover:text-nearblack"
        >
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <p className="label-caps mb-1">Supplier</p>
          <input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Invoice #</p>
          <input
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Date</p>
          <input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Amount ex GST</p>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
      </div>
      <label className="block">
        <p className="label-caps mb-1">PDF (optional)</p>
        <input ref={fileInput} type="file" accept="application/pdf" className="text-body" />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Saving…" : "Add to queue"}
      </button>
    </form>
  );
}
