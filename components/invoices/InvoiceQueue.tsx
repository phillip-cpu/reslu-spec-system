"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { CostSectionWithLines, Invoice, InvoiceMatchType, InvoiceStatus, Item } from "@/types";
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
  const [invoices, setInvoices] = useState<Invoice[]>([]);
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
    load();
  }, [load]);

  async function approve(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}/approve`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not approve invoice.");
      if (body.warning) setError(body.warning);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve invoice.");
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

  async function setMatch(
    id: string,
    match: { proposed_match_type: InvoiceMatchType | null; proposed_match_id: string | null }
  ) {
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(match),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not update match.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update match.");
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
                  onApprove={() => approve(inv.id)}
                  onReject={() => reject(inv.id)}
                  onSetMatch={(match) => setMatch(inv.id, match)}
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
  onSetMatch,
}: {
  invoice: Invoice;
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onSetMatch: (match: { proposed_match_type: InvoiceMatchType | null; proposed_match_id: string | null }) => void;
}) {
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
          <span className={clsx("label-caps border px-1.5 py-0.5", STATUS_STYLES[invoice.status])}>
            {invoice.status}
          </span>
        </td>
        <td className="px-2 py-1.5 text-caption text-charcoal/60">
          {invoice.proposed_match_type
            ? `${invoice.proposed_match_type === "cost_line" ? "Cost line" : "Item"} linked`
            : "No match"}
        </td>
        <td className="px-2 py-1.5">
          <div className="flex gap-2">
            {invoice.status !== "approved" && invoice.status !== "rejected" && (
              <>
                <button
                  type="button"
                  disabled={!invoice.proposed_match_type}
                  title={!invoice.proposed_match_type ? "Set a match before approving" : undefined}
                  onClick={onApprove}
                  className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                >
                  Approve
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
              <MatchPicker
                projectId={projectId}
                currentMatchType={invoice.proposed_match_type}
                currentMatchId={invoice.proposed_match_id}
                disabled={invoice.status === "approved" || invoice.status === "rejected"}
                onSelect={onSetMatch}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Set/change match: pick a section→cost line from the estimate, or a
 * spec register item. Reads the existing admin-gated estimate route
 * (for cost lines, grouped by section) and the team-visible items
 * route (for items) — both already exist, no new read endpoints needed.
 */
function MatchPicker({
  projectId,
  currentMatchType,
  currentMatchId,
  disabled,
  onSelect,
}: {
  projectId: string;
  currentMatchType: InvoiceMatchType | null;
  currentMatchId: string | null;
  disabled: boolean;
  onSelect: (match: { proposed_match_type: InvoiceMatchType | null; proposed_match_id: string | null }) => void;
}) {
  const [tab, setTab] = useState<InvoiceMatchType>(currentMatchType ?? "cost_line");
  const [sections, setSections] = useState<CostSectionWithLines[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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

  if (disabled) {
    return (
      <p className="text-caption text-charcoal/50">
        This invoice is {currentMatchType ? "already " : ""}
        {currentMatchType ? "finalised" : "not editable"} — match cannot be changed.
      </p>
    );
  }

  return (
    <div className="max-w-2xl space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
      <div className="flex items-center justify-between">
        <p className="label-caps">Set match</p>
        <div className="flex border border-[#c9c2b4]">
          {(["cost_line", "item"] as InvoiceMatchType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={clsx(
                "px-3 py-1 text-caption transition-colors",
                tab === t ? "bg-nearblack text-white" : "text-charcoal hover:bg-cream"
              )}
            >
              {t === "cost_line" ? "Cost line" : "Item"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-caption text-charcoal/50">Loading…</p>
      ) : tab === "cost_line" ? (
        <div className="max-h-56 overflow-y-auto">
          <button
            type="button"
            onClick={() => onSelect({ proposed_match_type: null, proposed_match_id: null })}
            className="block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body text-charcoal/60 hover:bg-cream"
          >
            No match
          </button>
          {sections.length === 0 ? (
            <p className="px-2 py-2 text-caption text-charcoal/50">No estimate sections yet.</p>
          ) : (
            sections.map((section) => (
              <div key={section.id}>
                <p className="px-2 py-1 text-caption text-charcoal/50">{section.name}</p>
                {section.lines.map((line) => (
                  <button
                    key={line.id}
                    type="button"
                    onClick={() => onSelect({ proposed_match_type: "cost_line", proposed_match_id: line.id })}
                    className={clsx(
                      "flex w-full items-center justify-between gap-3 border-b border-[#e5e0d6] px-3 py-1.5 text-left text-body hover:bg-cream",
                      currentMatchType === "cost_line" && currentMatchId === line.id
                        ? "bg-cream text-nearblack"
                        : "text-charcoal"
                    )}
                  >
                    <span className="truncate">{line.description}</span>
                    <span className="shrink-0 text-caption text-charcoal/40">
                      {line.actual_paid_ex_gst !== null ? `paid ${formatMoney(line.actual_paid_ex_gst)}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <button
            type="button"
            onClick={() => onSelect({ proposed_match_type: null, proposed_match_id: null })}
            className="block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body text-charcoal/60 hover:bg-cream"
          >
            No match
          </button>
          {items.length === 0 ? (
            <p className="px-2 py-2 text-caption text-charcoal/50">No items yet.</p>
          ) : (
            items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => onSelect({ proposed_match_type: "item", proposed_match_id: it.id })}
                className={clsx(
                  "flex w-full items-center justify-between gap-3 border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body hover:bg-cream",
                  currentMatchType === "item" && currentMatchId === it.id ? "bg-cream text-nearblack" : "text-charcoal"
                )}
              >
                <span>
                  {it.item_code} — {it.name}
                </span>
                {it.location && <span className="text-caption text-charcoal/40">{it.location}</span>}
              </button>
            ))
          )}
        </div>
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
