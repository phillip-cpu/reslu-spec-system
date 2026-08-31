"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { CostSectionWithLines, InvoiceMatchType, InvoiceStatus, Item } from "@/types";
import type {
  InvoiceAllocation,
  InvoiceWithAllocations,
  SupplierInvoiceLine,
} from "@/types/round-supplier-invoice-intake";
import type { InvoiceAllocationInput } from "@/lib/invoice-allocations";
import { invoiceAllocationBalance } from "@/lib/invoice-allocations";
import { supplierLineCostLineInput } from "@/lib/supplier-invoice-lines";
import { FINANCIAL_SUMMARY_CHANGED_EVENT } from "@/lib/project-financial-position";
import { formatMoney } from "@/components/estimate/EstimateWorkspace";
import type { ItemComponent } from "@/types/item-components";
import {
  deliveryAllowanceLineInput,
  isDeliveryDescription,
} from "@/lib/delivery-costs";

const STATUS_TABS: { value: InvoiceStatus | "all"; label: string }[] = [
  { value: "unmatched", label: "Unmatched" },
  { value: "proposed", label: "Proposed" },
  { value: "approved", label: "Approved" },
  { value: "all", label: "All" },
  { value: "rejected", label: "Rejected" },
  { value: "voided", label: "Voided" },
];

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  unmatched: "border-[#c9c2b4] text-charcoal/60",
  proposed: "border-sand text-sand",
  approved: "border-nearblack bg-nearblack text-white",
  rejected: "border-red-700/40 text-red-700",
  voided: "border-charcoal/30 bg-charcoal/10 text-charcoal/60",
};

interface Props {
  projectId: string;
  focusInvoiceId?: string;
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
export function InvoiceQueue({ projectId, focusInvoiceId }: Props) {
  const [invoices, setInvoices] = useState<InvoiceWithAllocations[]>([]);
  // Attention-first queue: land on work that still needs matching.
  // `load()` below automatically falls through to Approved when there
  // is no unmatched work, so the normal view never starts on the noisy
  // All tab (which also contains rejected and voided history).
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">(
    focusInvoiceId ? "approved" : "unmatched"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(focusInvoiceId ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const res = await fetch(`/api/projects/${projectId}/invoices${qs}`);
      let body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load invoices.");

      // When the working queue is clear, show the useful approved
      // record automatically instead of an empty Unmatched state. Keep
      // Rejected/Voided available as deliberate history filters only.
      if (statusFilter === "unmatched" && (body.invoices ?? []).length === 0) {
        const approvedResponse = await fetch(
          `/api/projects/${projectId}/invoices?status=approved`
        );
        body = await approvedResponse.json();
        if (!approvedResponse.ok) {
          throw new Error(body.error ?? "Could not load approved invoices.");
        }
        setStatusFilter("approved");
      }

      setInvoices(body.invoices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load invoices.");
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

  const refreshFinancialSummary = useCallback(async () => {
    await load();
    window.dispatchEvent(new Event(FINANCIAL_SUMMARY_CHANGED_EVENT));
  }, [load]);

  useEffect(() => {
    // Initial/filter-triggered network load; state updates happen after
    // the awaited request inside load(), not as derived render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (!focusInvoiceId || loading || !invoices.some((invoice) => invoice.id === focusInvoiceId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      document.getElementById(`supplier-invoice-${focusInvoiceId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusInvoiceId, invoices, loading]);

  async function approve(id: string, allocations: InvoiceAllocationInput[]) {
    setBusyId(id);
    setError(null);
    try {
      // One user action, two guarded server writes: persist the exact
      // line matches currently visible in the editor, then approve the
      // invoice against those saved allocations. If the save fails,
      // approval is never attempted. If approval fails, the allocations
      // remain safely saved so the same button can be retried.
      const saveResponse = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocations }),
      });
      const saveBody = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) {
        throw new Error(saveBody.error ?? "Could not save invoice line matches.");
      }

      const res = await fetch(`/api/invoices/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not approve invoice.");
      if (body.warning) setError(body.warning);
      await refreshFinancialSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve invoice.");
    } finally {
      setBusyId(null);
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
      await refreshFinancialSummary();
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
      await refreshFinancialSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reject invoice.");
    }
  }

  async function voidInvoice(id: string) {
    if (!confirm("Void this approved invoice and reverse its project actuals?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Voided by Phillip after invoice review" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not void invoice.");
      await refreshFinancialSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void invoice.");
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
      await refreshFinancialSummary();
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

      <UploadForm
        projectId={projectId}
        onCreated={refreshFinancialSummary}
        onError={setError}
      />

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
                  busy={busyId === inv.id}
                  onToggle={() => setExpandedId((cur) => (cur === inv.id ? null : inv.id))}
                  onApprove={(allocations) => approve(inv.id, allocations)}
                  onReject={() => reject(inv.id)}
                  onVoid={() => voidInvoice(inv.id)}
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
  busy,
  onToggle,
  onApprove,
  onReject,
  onVoid,
  onSaveAllocations,
  onSaveFields,
}: {
  invoice: InvoiceWithAllocations;
  projectId: string;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onApprove: (allocations: InvoiceAllocationInput[]) => Promise<void>;
  onReject: () => void;
  onVoid: () => void;
  onSaveAllocations: (allocations: InvoiceAllocationInput[]) => void;
  onSaveFields: (patch: Record<string, unknown>) => void;
}) {
  const editable =
    invoice.status !== "approved" &&
    invoice.status !== "rejected" &&
    invoice.status !== "voided";
  const savedAllocations = invoice.invoice_allocations ?? [];
  const hasSavedAllocations = savedAllocations.length > 0;
  const [editingFields, setEditingFields] = useState(false);
  const [fieldDrafts, setFieldDrafts] = useState({
    supplier: invoice.supplier,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date ?? "",
    due_date: invoice.due_date ?? "",
    amount_ex_gst: String(invoice.amount_ex_gst),
  });
  const [paymentDrafts, setPaymentDrafts] = useState({
    due_date: invoice.due_date ?? "",
    payment_status: invoice.payment_status,
    amount_paid: String(invoice.amount_paid),
    paid_at: invoice.paid_at ?? "",
  });
  // r24 — "Aria · needs approval": source='aria' AND not yet in a
  // terminal state (migration 052's own comment on invoices.source is
  // the single source of truth for this derivation — kept in sync with
  // it here rather than adding a server-computed flag for one pill).
  const needsAriaApproval = (invoice.source === "aria" || invoice.source === "stuart") && editable;

  function saveFieldEdits() {
    const amountNum = Number(fieldDrafts.amount_ex_gst);
    if (!fieldDrafts.supplier.trim() || !fieldDrafts.invoice_number.trim() || !Number.isFinite(amountNum)) return;
    onSaveFields({
      supplier: fieldDrafts.supplier.trim(),
      invoice_number: fieldDrafts.invoice_number.trim(),
      invoice_date: fieldDrafts.invoice_date || null,
      due_date: fieldDrafts.due_date || null,
      amount_ex_gst: amountNum,
    });
    setEditingFields(false);
  }

  return (
    <>
      <tr
        id={`supplier-invoice-${invoice.id}`}
        className={clsx(
          "border-b border-[#e5e0d6] align-top",
          expanded && "bg-sand/10"
        )}
      >
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
            ? `${
                invoice.proposed_match_type === "cost_line"
                  ? "Cost line"
                  : invoice.proposed_match_type === "item_component"
                    ? "Component"
                    : "Item"
              } linked`
            : "No match"}
        </td>
        <td className="px-2 py-1.5">
          <div className="flex gap-2">
            {editable && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onToggle}
                  className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                >
                  {expanded ? "Hide review" : "Review & approve"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onReject}
                  className="border border-red-700/40 px-2 py-1 text-caption text-red-700 hover:bg-red-700 hover:text-white disabled:opacity-40"
                >
                  Reject
                </button>
              </>
            )}
            {invoice.status === "approved" && (
              <button
                type="button"
                onClick={onVoid}
                className="border border-red-700/40 px-2 py-1 text-caption text-red-700 hover:bg-red-700 hover:text-white"
              >
                Void
              </button>
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
              {(invoice.source === "aria" || invoice.source === "stuart") && invoice.extracted && (
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
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
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
                      <label className="block">
                        <span className="label-caps mb-1 block !text-charcoal/50">Due date</span>
                        <input
                          type="date"
                          value={fieldDrafts.due_date}
                          onChange={(e) => setFieldDrafts((d) => ({ ...d, due_date: e.target.value }))}
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

              {invoice.status === "approved" && (
                <div className="space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
                  <p className="label-caps">Supplier cash payment</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="block">
                      <span className="label-caps mb-1 block !text-charcoal/50">Due date</span>
                      <input type="date" value={paymentDrafts.due_date}
                        onChange={(e) => setPaymentDrafts((d) => ({ ...d, due_date: e.target.value }))}
                        className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none" />
                    </label>
                    <label className="block">
                      <span className="label-caps mb-1 block !text-charcoal/50">Payment status</span>
                      <select value={paymentDrafts.payment_status}
                        onChange={(e) => setPaymentDrafts((d) => ({ ...d, payment_status: e.target.value as typeof d.payment_status }))}
                        className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none">
                        <option value="unpaid">Unpaid</option>
                        <option value="part_paid">Part paid</option>
                        <option value="paid">Paid</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="label-caps mb-1 block !text-charcoal/50">Gross paid inc GST</span>
                      <input type="number" min="0" max={invoice.total} step="0.01" value={paymentDrafts.amount_paid}
                        onChange={(e) => setPaymentDrafts((d) => ({ ...d, amount_paid: e.target.value }))}
                        className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none" />
                    </label>
                    <label className="block">
                      <span className="label-caps mb-1 block !text-charcoal/50">Latest payment date</span>
                      <input type="date" value={paymentDrafts.paid_at}
                        onChange={(e) => setPaymentDrafts((d) => ({ ...d, paid_at: e.target.value }))}
                        className="w-full border border-[#c9c2b4] bg-cream px-2 py-1 text-body focus:border-nearblack focus:outline-none" />
                    </label>
                  </div>
                  <button type="button" disabled={busy}
                    onClick={() => onSaveFields({
                      due_date: paymentDrafts.due_date || null,
                      payment_status: paymentDrafts.payment_status,
                      amount_paid: Number(paymentDrafts.amount_paid),
                      paid_at: paymentDrafts.paid_at || null,
                    })}
                    className="border border-nearblack px-3 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-40">
                    Save cash status
                  </button>
                  <p className="text-caption text-charcoal/50">Approval records the cost. Only payment status records cash leaving the bank.</p>
                </div>
              )}

              {invoice.library_cost_applied && (
                <p className="text-caption text-charcoal/50">Library product cost was updated from this invoice.</p>
              )}

              <AllocationEditor
                key={`${invoice.id}:${invoice.updated_at}:${savedAllocations
                  .map((allocation) => allocation.updated_at)
                  .join(",")}:${(invoice.supplier_invoice_lines ?? [])
                  .map((line) => line.updated_at)
                  .join(",")}`}
                projectId={projectId}
                invoiceAmountExGst={invoice.amount_ex_gst}
                savedAllocations={savedAllocations}
                sourceLines={invoice.supplier_invoice_lines ?? []}
                legacyMatch={
                  invoice.proposed_match_type && invoice.proposed_match_id
                    ? {
                        match_type: invoice.proposed_match_type,
                        match_id: invoice.proposed_match_id,
                        amount_ex_gst: invoice.amount_ex_gst,
                        apply_to_library_cost: true,
                      }
                    : null
                }
                disabled={
                  invoice.status === "approved" ||
                  invoice.status === "rejected" ||
                  invoice.status === "voided"
                }
                onSave={onSaveAllocations}
                onApprove={onApprove}
                approving={busy}
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
  source_line_id: string | null;
  source_line: SupplierInvoiceLine | null;
  match_type: InvoiceMatchType;
  match_id: string;
  amount: string;
  apply_to_library_cost: boolean;
  is_delivery: boolean;
  delivery_item_ids: string[];
}

function allocationDrafts(
  saved: InvoiceAllocation[],
  legacyMatch: InvoiceAllocationInput | null,
  sourceLines: SupplierInvoiceLine[]
): AllocationDraft[] {
  if (sourceLines.length > 0) {
    const savedBySource = new Map(
      saved
        .filter((allocation) => allocation.source_line_id)
        .map((allocation) => [allocation.source_line_id as string, allocation])
    );
    return [...sourceLines]
      .sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at))
      .map((line) => {
        const allocation = savedBySource.get(line.id);
        const delivery = isDeliveryDescription(line.description);
        const savedDeliveryTarget =
          delivery && allocation?.match_type === "cost_line" ? allocation.match_id : "";
        return {
          key: line.id,
          source_line_id: line.id,
          source_line: line,
          match_type: delivery
            ? "cost_line"
            : allocation?.match_type ?? line.suggested_match_type ?? "cost_line",
          match_id: delivery
            ? savedDeliveryTarget
            : allocation?.match_id ?? line.suggested_match_id ?? "",
          amount: String(line.amount_ex_gst),
          apply_to_library_cost: delivery
            ? false
            : allocation?.apply_to_library_cost ?? line.apply_to_library_cost ?? false,
          is_delivery:
            isDeliveryDescription(line.description) ||
            Boolean(allocation?.invoice_allocation_delivery_items?.length),
          delivery_item_ids:
            allocation?.invoice_allocation_delivery_items?.map((link) => link.item_id) ?? [],
        };
      });
  }

  const source = saved.length > 0 ? saved : legacyMatch ? [legacyMatch] : [];
  return source.map((allocation, index) => ({
    key: "id" in allocation ? String(allocation.id) : `legacy-${index}`,
    source_line_id: "source_line_id" in allocation ? (allocation.source_line_id ?? null) : null,
    source_line: null,
    match_type: allocation.match_type,
    match_id: allocation.match_id,
    amount: String(allocation.amount_ex_gst),
    apply_to_library_cost: allocation.apply_to_library_cost === true,
    is_delivery: Boolean(
      "invoice_allocation_delivery_items" in allocation &&
        allocation.invoice_allocation_delivery_items?.length
    ),
    delivery_item_ids:
      "invoice_allocation_delivery_items" in allocation
        ? allocation.invoice_allocation_delivery_items?.map((link) => link.item_id) ?? []
        : [],
  }));
}

/** Exact-cent, multi-line allocation editor. A draft cannot be saved
 * until every ex-GST cent has a real project target. */
function AllocationEditor({
  projectId,
  invoiceAmountExGst,
  savedAllocations,
  sourceLines,
  legacyMatch,
  disabled,
  onSave,
  onApprove,
  approving,
}: {
  projectId: string;
  invoiceAmountExGst: number;
  savedAllocations: InvoiceAllocation[];
  sourceLines: SupplierInvoiceLine[];
  legacyMatch: InvoiceAllocationInput | null;
  disabled: boolean;
  onSave: (allocations: InvoiceAllocationInput[]) => void;
  onApprove: (allocations: InvoiceAllocationInput[]) => Promise<void>;
  approving: boolean;
}) {
  const [drafts, setDrafts] = useState<AllocationDraft[]>(() =>
    allocationDrafts(savedAllocations, legacyMatch, sourceLines)
  );
  const [sections, setSections] = useState<CostSectionWithLines[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [components, setComponents] = useState<ItemComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingLineKey, setCreatingLineKey] = useState<string | null>(null);
  const [createLineErrors, setCreateLineErrors] = useState<Record<string, string>>({});
  const [createdInArea, setCreatedInArea] = useState<Record<string, string>>({});
  const locked = disabled || approving;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/projects/${projectId}/estimate`).then((r) => (r.ok ? r.json() : { sections: [] })),
      fetch(`/api/projects/${projectId}/items`).then((r) => (r.ok ? r.json() : { items: [] })),
      fetch(`/api/projects/${projectId}/item-components`).then((r) =>
        r.ok ? r.json() : { components: [] }
      ),
    ])
      .then(([estimateBody, itemsBody, componentsBody]) => {
        if (cancelled) return;
        const allItems = (itemsBody.items ?? []) as Item[];
        const directItems = allItems.filter(
          (item: Item) => item.cost_scope !== "trade_package"
        );
        const directItemIds = new Set(directItems.map((item: Item) => item.id));
        setSections(estimateBody.sections ?? []);
        setItems(allItems);
        setComponents(
          (componentsBody.components ?? []).filter((component: ItemComponent) =>
            directItemIds.has(component.item_id)
          )
        );
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const numericDrafts = drafts.map((draft) => ({ amount_ex_gst: Number(draft.amount) || 0 }));
  const balance = invoiceAllocationBalance(invoiceAmountExGst, numericDrafts);
  const sourceBacked = sourceLines.length > 0;
  const unmatchedCount = drafts.filter((draft) => !draft.match_id).length;
  const complete =
    drafts.length > 0 &&
    drafts.every((draft) => {
      if (!draft.match_id || Number(draft.amount) <= 0) return false;
      if (!draft.is_delivery) return true;
      return (
        draft.match_type === "cost_line" &&
        sections.some((section) =>
          section.lines.some(
            (line) => line.id === draft.match_id && line.line_kind === "delivery_allowance"
          )
        )
      );
    }) &&
    balance === 0;

  function linkedLibraryItem(
    matchType: InvoiceMatchType,
    matchId: string
  ): Item | ItemComponent | null {
    if (matchType === "item_component") {
      const component = components.find((candidate) => candidate.id === matchId);
      return component?.library_item_id ? component : null;
    }
    const itemId =
      matchType === "item"
        ? matchId
        : sections.flatMap((section) => section.lines).find((line) => line.id === matchId)?.item_id;
    if (!itemId) return null;
    const item = items.find((candidate) => candidate.id === itemId);
    return item?.library_item_id ? item : null;
  }

  function libraryTargetLabel(target: Item | ItemComponent): string {
    return "item_code" in target
      ? `${target.item_code} — ${target.name}`
      : `${target.name}${target.supplier_item_code ? ` · ${target.supplier_item_code}` : ""}`;
  }

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
        source_line_id: null,
        source_line: null,
        match_type: "cost_line",
        match_id: "",
        amount: remaining > 0 ? remaining.toFixed(2) : "",
        apply_to_library_cost: false,
        is_delivery: false,
        delivery_item_ids: [],
      },
    ]);
  }

  async function createCostLineInArea(draft: AllocationDraft, sectionId: string) {
    if (!draft.source_line || !sectionId || locked || creatingLineKey) return;
    setCreatingLineKey(draft.key);
    setCreateLineErrors((current) => ({ ...current, [draft.key]: "" }));

    try {
      const response = await fetch(`/api/estimate/sections/${sectionId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(supplierLineCostLineInput(draft.source_line)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.line) {
        throw new Error(body.error ?? "Could not create the cost line.");
      }

      const line = body.line as CostSectionWithLines["lines"][number];
      const areaName = sections.find((section) => section.id === sectionId)?.name ?? "the selected area";
      setSections((current) =>
        current.map((section) =>
          section.id === sectionId ? { ...section, lines: [...section.lines, line] } : section
        )
      );
      updateDraft(draft.key, {
        match_type: "cost_line",
        match_id: line.id,
        apply_to_library_cost: false,
      });
      setCreatedInArea((current) => ({ ...current, [draft.key]: areaName }));
    } catch (error) {
      setCreateLineErrors((current) => ({
        ...current,
        [draft.key]: error instanceof Error ? error.message : "Could not create the cost line.",
      }));
    } finally {
      setCreatingLineKey(null);
    }
  }

  async function createDeliveryAllowanceInArea(draft: AllocationDraft, sectionId: string) {
    if (!sectionId || locked || creatingLineKey) return;
    setCreatingLineKey(draft.key);
    setCreateLineErrors((current) => ({ ...current, [draft.key]: "" }));
    try {
      const response = await fetch(`/api/estimate/sections/${sectionId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deliveryAllowanceLineInput()),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.line) {
        throw new Error(body.error ?? "Could not create the Delivery allowance.");
      }
      const line = body.line as CostSectionWithLines["lines"][number];
      const areaName = sections.find((section) => section.id === sectionId)?.name ?? "the selected area";
      setSections((current) =>
        current.map((section) =>
          section.id === sectionId ? { ...section, lines: [...section.lines, line] } : section
        )
      );
      updateDraft(draft.key, {
        is_delivery: true,
        match_type: "cost_line",
        match_id: line.id,
        apply_to_library_cost: false,
      });
      setCreatedInArea((current) => ({ ...current, [draft.key]: areaName }));
    } catch (error) {
      setCreateLineErrors((current) => ({
        ...current,
        [draft.key]: error instanceof Error ? error.message : "Could not create the Delivery allowance.",
      }));
    } finally {
      setCreatingLineKey(null);
    }
  }

  async function approveAndApply() {
    if (!complete) return;
    await onApprove(
      drafts.map((draft) => ({
        source_line_id: draft.source_line_id,
        match_type: draft.match_type,
        match_id: draft.match_id,
        amount_ex_gst: Number(draft.amount),
        apply_to_library_cost:
          !draft.is_delivery && draft.apply_to_library_cost &&
          Boolean(linkedLibraryItem(draft.match_type, draft.match_id)),
        delivery_item_ids: draft.is_delivery ? draft.delivery_item_ids : [],
      }))
    );
  }

  return (
    <div className="max-w-4xl space-y-3 border border-[#dcd6cc] bg-nearwhite p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="label-caps">{sourceBacked ? "Invoice line matching" : "Invoice allocation"}</p>
          <p className="text-caption text-charcoal/50">
            {sourceBacked
              ? `${sourceLines.length} supplier line${sourceLines.length === 1 ? "" : "s"} · match each line to the estimate or specification before approval.`
              : `Split the full ${formatMoney(invoiceAmountExGst)} ex GST across the estimate or specification.`}
          </p>
        </div>
        <span
          className={clsx(
            "label-caps border px-2 py-1",
            complete
              ? "border-green-700/30 bg-green-50 !text-green-800"
              : "border-amber-700/30 bg-amber-50 !text-amber-800"
          )}
        >
          {complete
            ? sourceBacked
              ? "All lines matched"
              : "Fully allocated"
            : sourceBacked && unmatchedCount > 0
              ? `${unmatchedCount} line${unmatchedCount === 1 ? "" : "s"} need a destination`
            : balance === 0
              ? "Choose every destination"
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
          {drafts.map((draft, index) => {
            const libraryItem = draft.match_id
              ? linkedLibraryItem(draft.match_type, draft.match_id)
              : null;
            const sourceLine = draft.source_line;
            const matchedCostLine = sections
              .flatMap((section) => section.lines)
              .find((line) => draft.match_type === "cost_line" && line.id === draft.match_id);
            const deliveryMode =
              draft.is_delivery || matchedCostLine?.line_kind === "delivery_allowance";
            const directItems = items.filter((item) => item.cost_scope !== "trade_package");

            return (
              <div
                key={draft.key}
                className={clsx(
                  "grid grid-cols-1 gap-2 border border-[#e5e0d6] bg-cream p-3",
                  sourceBacked
                    ? "lg:grid-cols-[minmax(220px,1.1fr)_minmax(260px,1fr)_120px] lg:items-start"
                    : "md:grid-cols-[minmax(0,1fr)_130px_auto_auto] md:items-center"
                )}
              >
                {sourceLine && (
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-body font-medium text-nearblack">{sourceLine.description}</p>
                        <p className="text-caption text-charcoal/50">
                          {sourceLine.supplier_item_code ? `SKU ${sourceLine.supplier_item_code} · ` : ""}
                          Qty {sourceLine.quantity} {sourceLine.unit ?? ""}
                          {sourceLine.unit_price_ex_gst !== null
                            ? ` · ${formatMoney(sourceLine.unit_price_ex_gst)} each ex GST`
                            : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-body font-medium text-nearblack lg:hidden">
                        {formatMoney(sourceLine.amount_ex_gst)}
                      </span>
                    </div>
                    {(sourceLine.gst !== null || sourceLine.amount_inc_gst !== null) && (
                      <p className="text-caption text-charcoal/40">
                        {sourceLine.gst !== null ? `${formatMoney(sourceLine.gst)} GST` : ""}
                        {sourceLine.gst !== null && sourceLine.amount_inc_gst !== null ? " · " : ""}
                        {sourceLine.amount_inc_gst !== null
                          ? `${formatMoney(sourceLine.amount_inc_gst)} inc GST`
                          : ""}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  {!locked && (
                    <label className="flex items-center gap-2 text-caption text-charcoal/65">
                      <input
                        type="checkbox"
                        checked={deliveryMode}
                        onChange={(event) =>
                          updateDraft(draft.key, {
                            is_delivery: event.target.checked,
                            match_type: "cost_line",
                            match_id: "",
                            apply_to_library_cost: false,
                            delivery_item_ids: event.target.checked ? draft.delivery_item_ids : [],
                          })
                        }
                      />
                      This is Actual delivery / freight
                    </label>
                  )}

                  {deliveryMode ? (
                    <div className="space-y-2 border border-sand/50 bg-offwhite p-2">
                      <label className="block">
                        <span className="label-caps mb-1 block !text-charcoal/50">Actual delivery</span>
                        <select
                          disabled={locked}
                          value={draft.match_id}
                          onChange={(event) =>
                            updateDraft(draft.key, {
                              is_delivery: true,
                              match_type: "cost_line",
                              match_id: event.target.value,
                              apply_to_library_cost: false,
                            })
                          }
                          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                        >
                          <option value="">Choose a Delivery allowance…</option>
                          {sections.map((section) => {
                            const allowances = section.lines.filter(
                              (line) => line.line_kind === "delivery_allowance"
                            );
                            return allowances.length > 0 ? (
                              <optgroup key={section.id} label={`Estimate · ${section.name}`}>
                                {allowances.map((line) => (
                                  <option key={line.id} value={line.id}>
                                    {line.description} · allowed {formatMoney(
                                      line.quoted_to_client_ex_gst ?? line.cost_ex_gst ?? 0
                                    )} · actual {formatMoney(line.actual_paid_ex_gst ?? 0)}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null;
                          })}
                        </select>
                      </label>

                      {!draft.match_id && (
                        <label className="block">
                          <span className="label-caps mb-1 block !text-charcoal/50">
                            No allowance yet?
                          </span>
                          <select
                            disabled={locked || Boolean(creatingLineKey) || sections.length === 0}
                            value=""
                            onChange={(event) => {
                              if (event.target.value) {
                                void createDeliveryAllowanceInArea(draft, event.target.value);
                              }
                            }}
                            className="w-full border border-[#c9c2b4] bg-cream px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                          >
                            <option value="">
                              {creatingLineKey === draft.key
                                ? "Creating Delivery allowance…"
                                : "Create a $0 Delivery allowance in…"}
                            </option>
                            {sections.map((section) => (
                              <option key={section.id} value={section.id}>{section.name}</option>
                            ))}
                          </select>
                        </label>
                      )}

                      <fieldset>
                        <legend className="label-caps mb-1 !text-charcoal/50">
                          Related FF&amp;E items (optional)
                        </legend>
                        <div className="max-h-36 space-y-1 overflow-y-auto border border-[#e5e0d6] bg-nearwhite p-2">
                          {items.length === 0 ? (
                            <p className="text-caption text-charcoal/45">No FF&amp;E items available.</p>
                          ) : items.map((item) => (
                            <label key={item.id} className="flex items-start gap-2 text-caption text-charcoal/70">
                              <input
                                type="checkbox"
                                disabled={locked}
                                checked={draft.delivery_item_ids.includes(item.id)}
                                onChange={(event) =>
                                  updateDraft(draft.key, {
                                    delivery_item_ids: event.target.checked
                                      ? [...draft.delivery_item_ids, item.id]
                                      : draft.delivery_item_ids.filter((id) => id !== item.id),
                                  })
                                }
                              />
                              <span>
                                {item.item_code} — {item.name}
                                {item.cost_scope === "trade_package" ? " · included in trade package" : ""}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <p className="text-caption text-charcoal/55">
                        Actual delivery posts to the allowance. Related FF&amp;E items are traceability only;
                        their reusable base and library prices are not changed.
                      </p>
                      {createLineErrors[draft.key] && (
                        <p className="text-caption text-red-700">{createLineErrors[draft.key]}</p>
                      )}
                    </div>
                  ) : (
                    <>
                  <label>
                    <span className={sourceLine ? "label-caps mb-1 block !text-charcoal/50" : "sr-only"}>
                      {sourceLine ? "Match to project" : `Allocation ${index + 1} match`}
                    </span>
                    <select
                      disabled={locked}
                      value={draft.match_id ? `${draft.match_type}:${draft.match_id}` : ""}
                      onChange={(event) => {
                        const [matchType, matchId] = event.target.value.split(":");
                        const nextType = (matchType || "cost_line") as InvoiceMatchType;
                        const nextId = matchId ?? "";
                        updateDraft(draft.key, {
                          match_type: nextType,
                          match_id: nextId,
                          apply_to_library_cost: Boolean(nextId && linkedLibraryItem(nextType, nextId)),
                        });
                        setCreatedInArea((current) => ({ ...current, [draft.key]: "" }));
                      }}
                      className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                    >
                      <option value="">Choose a cost line, item or component…</option>
                      {sections.map((section) => (
                        <optgroup key={section.id} label={`Estimate · ${section.name}`}>
                          {section.lines.filter((line) => line.line_kind !== "delivery_allowance").map((line) => (
                            <option key={line.id} value={`cost_line:${line.id}`}>
                              {line.description}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      {directItems.length > 0 && (
                        <optgroup label="Specification items">
                          {directItems.map((item) => (
                            <option key={item.id} value={`item:${item.id}`}>
                              {item.item_code} — {item.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {components.length > 0 && (
                        <optgroup label="Assembly components">
                          {components.map((component) => {
                            const parent = items.find((item) => item.id === component.item_id);
                            return (
                              <option
                                key={component.id}
                                value={`item_component:${component.id}`}
                              >
                                {parent ? `${parent.item_code} — ` : ""}
                                {component.name}
                                {component.supplier_item_code
                                  ? ` · ${component.supplier_item_code}`
                                  : ""}
                              </option>
                            );
                          })}
                        </optgroup>
                      )}
                    </select>
                  </label>

                  {sourceLine && !draft.match_id && (
                    <label className="block border border-dashed border-[#c9c2b4] bg-nearwhite p-2">
                      <span className="label-caps mb-1 block !text-charcoal/50">No destination yet?</span>
                      <select
                        disabled={locked || Boolean(creatingLineKey) || sections.length === 0}
                        value=""
                        onChange={(event) => {
                          const sectionId = event.target.value;
                          if (sectionId) void createCostLineInArea(draft, sectionId);
                        }}
                        className="w-full border border-[#c9c2b4] bg-cream px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                        aria-label={`Add ${sourceLine.description} to an estimate area`}
                      >
                        <option value="">
                          {creatingLineKey === draft.key
                            ? "Creating cost line…"
                            : sections.length === 0
                              ? "No estimate areas available"
                              : "Add to an area as a new cost line…"}
                        </option>
                        {sections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.name}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-caption text-charcoal/50">
                        Choosing an area creates an unplanned-cost line with a $0 client quote.
                        Approval posts this invoice amount as the actual paid cost and exposes the loss.
                      </span>
                      {createLineErrors[draft.key] && (
                        <span className="mt-1 block text-caption text-red-700">
                          {createLineErrors[draft.key]}
                        </span>
                      )}
                    </label>
                  )}

                  {sourceLine && draft.match_id && createdInArea[draft.key] && (
                    <p className="text-caption text-green-800">
                      New cost line created in {createdInArea[draft.key]} and selected.
                    </p>
                  )}

                  {sourceLine?.suggestion_note && (
                    <p className="text-caption text-amber-800">Aria&apos;s note: {sourceLine.suggestion_note}</p>
                  )}

                  {sourceLine && (
                    <label
                      className={clsx(
                        "flex items-start gap-1.5 text-caption",
                        libraryItem ? "text-charcoal/70" : "text-charcoal/35"
                      )}
                      title={
                        libraryItem
                          ? `Update ${libraryTargetLabel(libraryItem)} in the library from this supplier unit price`
                          : "Choose a component or specification item linked to the library, or an estimate line linked to one"
                      }
                    >
                      <input
                        disabled={locked || !libraryItem}
                        type="checkbox"
                        checked={draft.apply_to_library_cost && Boolean(libraryItem)}
                        onChange={(event) =>
                          updateDraft(draft.key, { apply_to_library_cost: event.target.checked })
                        }
                        className="mt-0.5"
                      />
                      <span>
                        {libraryItem
                          ? `Update library price for ${libraryTargetLabel(libraryItem)}`
                          : "Library price update unavailable for this destination"}
                      </span>
                    </label>
                  )}
                    </>
                  )}
                </div>

                {sourceLine ? (
                  <div className="hidden text-right lg:block">
                    <p className="label-caps !text-charcoal/50">Line ex GST</p>
                    <p className="mt-1 text-body font-medium text-nearblack">
                      {formatMoney(sourceLine.amount_ex_gst)}
                    </p>
                  </div>
                ) : (
                  <label>
                    <span className="sr-only">Allocation {index + 1} ex-GST amount</span>
                    <input
                      disabled={locked}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={draft.amount}
                      onChange={(event) => updateDraft(draft.key, { amount: event.target.value })}
                      className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-right text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                      aria-label={`Allocation ${index + 1} amount ex GST`}
                    />
                  </label>
                )}

                {!sourceLine && !deliveryMode && (
                  <label className="flex items-center gap-1.5 text-caption text-charcoal/60">
                    <input
                      disabled={locked || !libraryItem}
                      type="checkbox"
                      checked={draft.apply_to_library_cost && Boolean(libraryItem)}
                      onChange={(event) =>
                        updateDraft(draft.key, { apply_to_library_cost: event.target.checked })
                      }
                    />
                    Update library price
                  </label>
                )}

                {!locked && !sourceLine && (
                  <button
                    type="button"
                    onClick={() => setDrafts((current) => current.filter((row) => row.key !== draft.key))}
                    className="text-caption text-red-700 hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          {!sourceBacked && (
            <button
              type="button"
              disabled={approving}
              onClick={addAllocation}
              className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack disabled:opacity-40"
            >
              + Add allocation
            </button>
          )}
          <button
            type="button"
            disabled={!complete || approving}
            onClick={() => void approveAndApply()}
            className="border border-nearblack bg-nearblack px-3 py-1.5 text-caption text-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            {approving ? "Saving & approving…" : "Approve & apply invoice"}
          </button>
          {savedAllocations.length > 0 && (
            <button
              type="button"
              disabled={approving}
              onClick={() => {
                if (confirm("Clear every saved allocation from this invoice?")) onSave([]);
              }}
              className="text-caption text-charcoal/50 hover:text-red-700 disabled:opacity-40"
            >
              Clear saved allocations
            </button>
          )}
        </div>
      )}

      {!disabled && !complete && drafts.length > 0 && (
        <p className="text-caption text-amber-800">
          Approval stays locked until every {sourceBacked ? "supplier line" : "allocation"} has a project
          destination and the remaining balance is $0.00.
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
  const [gst, setGst] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Array<{
    key: string;
    supplier_item_code: string;
    description: string;
    quantity: string;
    unit: string;
    unit_price_ex_gst: string;
    amount_ex_gst: string;
  }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function addLine() {
    setLines((current) => [
      ...current,
      {
        key: `manual-line-${Date.now()}-${current.length}`,
        supplier_item_code: "",
        description: "",
        quantity: "1",
        unit: "ea",
        unit_price_ex_gst: "",
        amount_ex_gst: "",
      },
    ]);
  }

  function updateLine(
    key: string,
    field: "supplier_item_code" | "description" | "quantity" | "unit" | "unit_price_ex_gst" | "amount_ex_gst",
    value: string
  ) {
    setLines((current) =>
      current.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, [field]: value };
        if (field === "quantity" || field === "unit_price_ex_gst") {
          const quantity = Number(next.quantity);
          const unitPrice = Number(next.unit_price_ex_gst);
          if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitPrice) && unitPrice >= 0) {
            next.amount_ex_gst = String(roundMoney(quantity * unitPrice));
          }
        }
        return next;
      })
    );
  }

  const lineSubtotal = roundMoney(
    lines.reduce((sum, line) => {
      const value = Number(line.amount_ex_gst);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0)
  );
  const amountNum = lines.length > 0 ? lineSubtotal : Number(amount);
  const gstNum = gst === "" ? roundMoney((Number.isFinite(amountNum) ? amountNum : 0) * 0.1) : Number(gst);
  const totalNum = roundMoney(
    (Number.isFinite(amountNum) ? amountNum : 0) + (Number.isFinite(gstNum) ? gstNum : 0)
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !supplier.trim() ||
      !invoiceNumber.trim() ||
      !invoiceDate ||
      !Number.isFinite(amountNum) ||
      amountNum <= 0 ||
      !Number.isFinite(gstNum) ||
      gstNum < 0
    ) {
      onError("Supplier, invoice number, date and a valid amount are required.");
      return;
    }
    if (
      lines.some(
        (line) =>
          !line.description.trim() ||
          !Number.isFinite(Number(line.quantity)) ||
          Number(line.quantity) <= 0 ||
          !Number.isFinite(Number(line.amount_ex_gst)) ||
          Number(line.amount_ex_gst) <= 0
      )
    ) {
      onError("Every invoice line needs a description, quantity and ex-GST amount.");
      return;
    }
    setSubmitting(true);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("supplier", supplier.trim());
      fd.append("invoice_number", invoiceNumber.trim());
      fd.append("invoice_date", invoiceDate);
      fd.append("amount_ex_gst", String(amountNum));
      fd.append("gst", String(gstNum));
      fd.append("total", String(totalNum));
      if (notes.trim()) fd.append("confidence_note", notes.trim());
      if (lines.length > 0) {
        fd.append(
          "line_items",
          JSON.stringify(
            lines.map((line) => ({
              supplier_item_code: line.supplier_item_code.trim() || null,
              description: line.description.trim(),
              quantity: Number(line.quantity),
              unit: line.unit.trim() || null,
              unit_price_ex_gst:
                line.unit_price_ex_gst === "" ? null : Number(line.unit_price_ex_gst),
              amount_ex_gst: Number(line.amount_ex_gst),
              gst: null,
              amount_inc_gst: null,
            }))
          )
        );
      }
      const file = fileInput.current?.files?.[0];
      if (file) fd.append("file", file);

      const res = await fetch(`/api/projects/${projectId}/invoices`, {
        method: "POST",
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not create invoice.");
      setSupplier("");
      setInvoiceNumber("");
      setInvoiceDate("");
      setAmount("");
      setGst("");
      setNotes("");
      setLines([]);
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
        + Enter manual invoice
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="label-caps">Manual supplier invoice</p>
          <p className="mt-1 text-caption text-charcoal/55">
            Enter the invoice exactly as issued. It will remain unapproved until you allocate and approve it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-caption text-charcoal/50 hover:text-nearblack"
        >
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <p className="label-caps mb-1">Supplier</p>
          <input
            required
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Invoice #</p>
          <input
            required
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Date</p>
          <input
            required
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
      </div>

      <div className="space-y-3 border border-[#dcd6cc] bg-nearwhite p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="label-caps">Invoice line items</p>
            <p className="mt-1 text-caption text-charcoal/55">
              Optional, but recommended—each product can later be matched to a cost line, specification item or component.
            </p>
          </div>
          <button
            type="button"
            onClick={addLine}
            className="border border-nearblack px-3 py-1.5 text-caption text-nearblack hover:bg-nearblack hover:text-white"
          >
            + Add line
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="border border-dashed border-[#c9c2b4] p-3 text-caption text-charcoal/55">
            No individual lines added. You can enter one invoice total below.
          </p>
        ) : (
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={line.key} className="grid grid-cols-12 gap-2 border-t border-[#e4ded3] pt-2 first:border-0 first:pt-0">
                <input
                  aria-label={`Line ${index + 1} code`}
                  placeholder="SKU / code"
                  value={line.supplier_item_code}
                  onChange={(e) => updateLine(line.key, "supplier_item_code", e.target.value)}
                  className="col-span-12 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body sm:col-span-2"
                />
                <input
                  required
                  aria-label={`Line ${index + 1} description`}
                  placeholder="Item description"
                  value={line.description}
                  onChange={(e) => updateLine(line.key, "description", e.target.value)}
                  className="col-span-12 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body sm:col-span-4"
                />
                <input
                  required
                  aria-label={`Line ${index + 1} quantity`}
                  type="number"
                  min="0.001"
                  step="0.001"
                  placeholder="Qty"
                  value={line.quantity}
                  onChange={(e) => updateLine(line.key, "quantity", e.target.value)}
                  className="col-span-3 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body sm:col-span-1"
                />
                <input
                  aria-label={`Line ${index + 1} unit`}
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => updateLine(line.key, "unit", e.target.value)}
                  className="col-span-3 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body sm:col-span-1"
                />
                <input
                  aria-label={`Line ${index + 1} unit price ex GST`}
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Unit $ ex"
                  value={line.unit_price_ex_gst}
                  onChange={(e) => updateLine(line.key, "unit_price_ex_gst", e.target.value)}
                  className="col-span-6 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body sm:col-span-2"
                />
                <div className="col-span-10 flex items-center border border-[#c9c2b4] bg-white sm:col-span-2">
                  <span className="px-2 text-caption text-charcoal/50">$</span>
                  <input
                    required
                    aria-label={`Line ${index + 1} amount ex GST`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="Line ex GST"
                    value={line.amount_ex_gst}
                    onChange={(e) => updateLine(line.key, "amount_ex_gst", e.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-1.5 pr-2 text-body focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Remove line ${index + 1}`}
                  onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}
                  className="col-span-2 text-caption text-red-700 sm:col-span-12 sm:justify-self-end"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <p className="label-caps mb-1">Amount ex GST</p>
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            readOnly={lines.length > 0}
            value={lines.length > 0 ? lineSubtotal : amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body read-only:bg-[#eee9df] focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">GST</p>
          <input
            required
            type="number"
            min="0"
            step="0.01"
            value={gst === "" ? gstNum : gst}
            onChange={(e) => setGst(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Total inc GST</p>
          <input
            readOnly
            value={totalNum.toFixed(2)}
            className="w-full border border-[#c9c2b4] bg-[#eee9df] px-2 py-1.5 text-body"
          />
        </label>
      </div>

      <label className="block">
        <p className="label-caps mb-1">Notes (optional)</p>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Project context, delivery details or anything needed for allocation"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
      </label>
      <label className="block">
        <p className="label-caps mb-1">Invoice or receipt (optional)</p>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="text-body"
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Saving…" : "Save manual invoice"}
      </button>
    </form>
  );
}
