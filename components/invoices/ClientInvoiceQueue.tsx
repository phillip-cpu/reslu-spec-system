"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type { ClientInvoice, ClientInvoiceKind, ClientInvoiceLineItem, ClientInvoiceStatus } from "@/types/client-invoices";

const STATUS_STYLES: Record<ClientInvoiceStatus, string> = {
  draft: "border-[#c9c2b4] text-charcoal/60",
  sent: "border-sand text-sand",
  paid: "border-nearblack bg-nearblack text-white",
  void: "border-red-700/40 text-red-700",
};

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

interface Props {
  projectId: string;
  /** Prefills the "New invoice" composer's client fields — the invoice
   * still stores its OWN snapshot of these (migration 046's own column
   * comments), so editing the project's client details later never
   * rewrites an already-created invoice. */
  projectClientName: string;
  projectClientEmail: string | null;
  projectAddress: string | null;
  /** Server-computed (process.env.STRIPE_SECRET_KEY presence) — gates
   * whether "Create payment link" is even offered per row, same
   * "booleans computed server-side, never the raw env exposed"
   * convention as components/settings/IntegrationStatus.tsx. */
  stripeConfigured: boolean;
}

/**
 * "Client invoices" section of the project Invoices tab — money IN
 * (RESLU bills the client), sitting alongside (not replacing) the
 * existing supplier InvoiceQueue on the same page (money OUT). Admin-
 * only, same gating shape as InvoiceQueue.tsx: the page itself already
 * blocks non-admins before this component ever mounts, and every API
 * route this component calls independently re-checks admin too.
 *
 * BUILD-SPEC.md this round: "Global /invoices list? SKIP v1
 * (project-scoped only, document)" — there is deliberately no
 * cross-project client-invoices view yet; this component only ever
 * queries ONE project's invoices.
 */
export function ClientInvoiceQueue({
  projectId,
  projectClientName,
  projectClientEmail,
  projectAddress,
  stripeConfigured,
}: Props) {
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-invoices`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load client invoices.");
      setInvoices(body.invoices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load client invoices.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(id: string, action: "send" | "resend" | "mark-paid" | "void" | "stripe-link") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/client-invoices/${id}/${action}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Could not ${action.replace("-", " ")} invoice.`);
      if (body.warning) setError(body.warning);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action.replace("-", " ")} invoice.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <ComposerForm
        projectId={projectId}
        projectClientName={projectClientName}
        projectClientEmail={projectClientEmail}
        projectAddress={projectAddress}
        onCreated={load}
        onError={setError}
      />

      {loading ? (
        <p className="text-body text-charcoal/50">Loading client invoices…</p>
      ) : invoices.length === 0 ? (
        <p className="border border-dashed border-[#c9c2b4] p-8 text-center text-body text-charcoal/50">
          No client invoices yet.
        </p>
      ) : (
        <div className="overflow-x-auto border border-[#dcd6cc]">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="border-b border-[#dcd6cc] bg-cream text-left">
                <th className="label-caps px-2 py-1.5">Number</th>
                <th className="label-caps px-2 py-1.5">Client</th>
                <th className="label-caps px-2 py-1.5 text-right">Total (inc GST)</th>
                <th className="label-caps px-2 py-1.5">Status</th>
                <th className="label-caps px-2 py-1.5">Issued</th>
                <th className="label-caps px-2 py-1.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-[#e5e0d6] align-top">
                  <td className="px-2 py-1.5 text-body text-nearblack">{inv.invoice_number}</td>
                  <td className="px-2 py-1.5 text-body">{inv.client_name}</td>
                  <td className="px-2 py-1.5 text-right text-body">{formatMoney(inv.total_inc_gst)}</td>
                  <td className="px-2 py-1.5">
                    <span className={clsx("label-caps border px-1.5 py-0.5", STATUS_STYLES[inv.status])}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-body text-charcoal/70">
                    {inv.issued_at ? new Date(inv.issued_at).toLocaleDateString("en-AU") : "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={`/api/client-invoices/${inv.id}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                        className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white"
                      >
                        Preview PDF
                      </a>
                      {inv.status === "draft" && (
                        <button
                          type="button"
                          disabled={busyId === inv.id || !inv.client_email}
                          title={!inv.client_email ? "Add a client email before sending" : undefined}
                          onClick={() => runAction(inv.id, "send")}
                          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Send
                        </button>
                      )}
                      {inv.status === "sent" && (
                        <button
                          type="button"
                          disabled={busyId === inv.id || !inv.client_email}
                          title={
                            !inv.client_email
                              ? "Add a client email before resending"
                              : "Re-email the client with the current PDF — e.g. after creating a payment link"
                          }
                          onClick={() => runAction(inv.id, "resend")}
                          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Resend
                        </button>
                      )}
                      {(inv.status === "draft" || inv.status === "sent") && (
                        <button
                          type="button"
                          disabled={busyId === inv.id}
                          onClick={() => runAction(inv.id, "mark-paid")}
                          className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Mark paid
                        </button>
                      )}
                      {stripeConfigured && (inv.status === "draft" || inv.status === "sent") && !inv.stripe_payment_url && (
                        <button
                          type="button"
                          disabled={busyId === inv.id}
                          onClick={() => runAction(inv.id, "stripe-link")}
                          className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Create payment link
                        </button>
                      )}
                      {(inv.status === "draft" || inv.status === "sent") && (
                        <button
                          type="button"
                          disabled={busyId === inv.id}
                          onClick={() => {
                            if (confirm("Void this invoice? The number can never be reused.")) {
                              runAction(inv.id, "void");
                            }
                          }}
                          className="border border-red-700/40 px-2 py-1 text-caption text-red-700 hover:bg-red-700 hover:text-white disabled:opacity-40"
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function emptyLine(): ClientInvoiceLineItem {
  return { description: "", amount_ex_gst: 0 };
}

function ComposerForm({
  projectId,
  projectClientName,
  projectClientEmail,
  projectAddress,
  onCreated,
  onError,
}: {
  projectId: string;
  projectClientName: string;
  projectClientEmail: string | null;
  projectAddress: string | null;
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ClientInvoiceKind>("design_fee");
  const [clientName, setClientName] = useState(projectClientName);
  const [clientEmail, setClientEmail] = useState(projectClientEmail ?? "");
  const [address, setAddress] = useState(projectAddress ?? "");
  const [dueDays, setDueDays] = useState("14");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ClientInvoiceLineItem[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);

  const subtotal = lines.reduce((sum, l) => sum + (Number(l.amount_ex_gst) || 0), 0);
  // Display-only estimate matching lib/client-invoices.ts's rounding
  // rule closely enough for the composer preview; the SERVER recomputes
  // the authoritative subtotal/gst/total on submit (this component
  // never sends these figures to the API).
  const gstEstimate = Math.round(subtotal * 0.1 * 100) / 100;
  const totalEstimate = Math.round((subtotal + gstEstimate) * 100) / 100;

  function updateLine(index: number, patch: Partial<ClientInvoiceLineItem>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cleanedLines = lines
      .map((l) => ({ description: l.description.trim(), amount_ex_gst: Number(l.amount_ex_gst) }))
      .filter((l) => l.description && Number.isFinite(l.amount_ex_gst));
    if (!clientName.trim()) {
      onError("Client name is required.");
      return;
    }
    if (cleanedLines.length === 0) {
      onError("Add at least one line item with a description and amount.");
      return;
    }
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          client_name: clientName.trim(),
          client_email: clientEmail.trim() || null,
          address: address.trim() || null,
          due_days: Number(dueDays) || 14,
          notes: notes.trim() || null,
          line_items: cleanedLines,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not create invoice.");
      setKind("design_fee");
      setLines([emptyLine()]);
      setNotes("");
      setDueDays("14");
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
        + New invoice
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex items-center justify-between">
        <p className="label-caps">New client invoice</p>
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
          <p className="label-caps mb-1">Kind</p>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ClientInvoiceKind)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="design_fee">Design fee</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="block">
          <p className="label-caps mb-1">Client name</p>
          <input
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Client email</p>
          <input
            type="email"
            value={clientEmail}
            onChange={(e) => setClientEmail(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Due (days)</p>
          <input
            type="number"
            min="0"
            value={dueDays}
            onChange={(e) => setDueDays(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
      </div>

      <label className="block">
        <p className="label-caps mb-1">Address</p>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
      </label>

      <div className="space-y-2">
        <p className="label-caps">Line items</p>
        {lines.map((line, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={line.description}
              onChange={(e) => updateLine(i, { description: e.target.value })}
              placeholder="Description"
              className="flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
            />
            <input
              type="number"
              step="0.01"
              value={line.amount_ex_gst}
              onChange={(e) => updateLine(i, { amount_ex_gst: Number(e.target.value) })}
              placeholder="Amount ex GST"
              className="w-36 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-right text-body focus:border-nearblack focus:outline-none"
            />
            <button
              type="button"
              onClick={() => removeLine(i)}
              disabled={lines.length === 1}
              className="text-caption text-charcoal/50 hover:text-red-700 disabled:opacity-30"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addLine}
          className="text-caption text-nearblack underline hover:no-underline"
        >
          + Add line
        </button>
      </div>

      <label className="block">
        <p className="label-caps mb-1">Notes (optional)</p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
      </label>

      <div className="flex items-center justify-between border-t border-[#e5e0d6] pt-3">
        <p className="text-caption text-charcoal/60">
          Estimated subtotal {formatMoney(subtotal)} · GST {formatMoney(gstEstimate)} · total{" "}
          {formatMoney(totalEstimate)} — the server recomputes the exact figures on save.
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Create draft"}
        </button>
      </div>
    </form>
  );
}
