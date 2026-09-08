"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

type PaymentStatus = "unpaid" | "part_paid" | "paid";

type CompanyInvoice = {
  id: string;
  expense_scope: "company" | "unallocated";
  supplier: string;
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  currency_code: string | null;
  amount_ex_gst: number;
  gst: number;
  total: number;
  status: string;
  payment_status: PaymentStatus;
  amount_paid: number;
  paid_at: string | null;
  company_expense_category: string | null;
  recurring_commitment_id: string | null;
  recurring_due_date: string | null;
  finance_recurring_commitments: {
    id: string;
    name: string;
    first_due_date: string;
    frequency: string;
    end_date: string | null;
  } | null;
};

type PaymentUpdate = Pick<CompanyInvoice, "due_date" | "payment_status" | "amount_paid" | "paid_at" | "recurring_due_date">;

function money(amount: number, currency: string | null): string {
  if (!currency) return `${amount.toFixed(2)} · currency unresolved`;
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(amount);
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function dateLabel(value: string | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Adelaide",
  }).format(new Date(`${value}T00:00:00Z`));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function CompanyInvoicePaymentEditor({ invoice, onSaved, onCancel }: {
  invoice: CompanyInvoice;
  onSaved: (payment: PaymentUpdate) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({
    due_date: invoice.due_date ?? "",
    payment_status: invoice.payment_status ?? "unpaid",
    amount_paid: String(invoice.amount_paid ?? 0),
    paid_at: invoice.paid_at ?? "",
    recurring_due_date: invoice.recurring_due_date ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldClass = "mt-1 w-full border border-charcoal/25 bg-offwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-50";

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const amount = Number(draft.amount_paid);
    const total = Number(invoice.total);
    if (!draft.amount_paid.trim() || !Number.isFinite(amount) || amount < 0 || amount > total || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) {
      setError("Enter the total amount paid, between zero and the invoice total, to two decimal places.");
      return;
    }
    if ((draft.due_date && !validDate(draft.due_date)) || (draft.recurring_due_date && !validDate(draft.recurring_due_date))) {
      setError("Enter a valid due date.");
      return;
    }
    const coherent =
      (draft.payment_status === "unpaid" && amount === 0 && !draft.paid_at) ||
      (draft.payment_status === "part_paid" && amount > 0 && amount < total && validDate(draft.paid_at)) ||
      (draft.payment_status === "paid" && amount === total && validDate(draft.paid_at));
    if (!coherent) {
      setError(draft.payment_status === "part_paid"
        ? "For a part payment, enter an amount below the invoice total and the latest payment date."
        : "For a paid invoice, record the full invoice total and the actual payment date.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          due_date: draft.due_date || null,
          payment_status: draft.payment_status,
          amount_paid: amount,
          paid_at: draft.paid_at || null,
          ...(invoice.recurring_commitment_id ? { recurring_due_date: draft.recurring_due_date || null } : {}),
        }),
      });
      const body = await response.json() as { invoice?: PaymentUpdate; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save the payment");
      if (!body.invoice) throw new Error("Payment saved, but its details could not be reloaded. Refresh company bills.");
      await onSaved(body.invoice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the payment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4" aria-label={`Payment for ${invoice.supplier} invoice ${invoice.invoice_number}`}>
      <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <legend className="mb-3 text-body font-medium text-nearblack">Record payment · {invoice.supplier} · {invoice.invoice_number}</legend>
        <label className="text-caption text-charcoal/70">Payment status
          <select className={fieldClass} value={draft.payment_status} onChange={(event) => {
            const status = event.target.value as PaymentStatus;
            setDraft((current) => ({
              ...current,
              payment_status: status,
              amount_paid: status === "paid" ? String(invoice.total) : status === "unpaid" ? "0" : current.payment_status === "part_paid" ? current.amount_paid : "",
              paid_at: status === "unpaid" ? "" : current.paid_at,
            }));
          }}>
            <option value="unpaid">Unpaid</option>
            <option value="part_paid">Part paid</option>
            <option value="paid">Paid</option>
          </select>
        </label>
        <label className="text-caption text-charcoal/70">Total paid including GST{invoice.currency_code ? ` (${invoice.currency_code})` : ""}
          <input type="number" min="0" max={invoice.total} step="0.01" required disabled={draft.payment_status !== "part_paid"} className={fieldClass} value={draft.amount_paid} onChange={(event) => setDraft((current) => ({ ...current, amount_paid: event.target.value }))} />
        </label>
        <label className="text-caption text-charcoal/70">{draft.payment_status === "part_paid" ? "Latest payment date" : "Payment date"}
          <input type="date" required={draft.payment_status !== "unpaid"} disabled={draft.payment_status === "unpaid"} className={fieldClass} value={draft.paid_at} onChange={(event) => setDraft((current) => ({ ...current, paid_at: event.target.value }))} />
        </label>
        <label className="text-caption text-charcoal/70">Invoice due date
          <input type="date" className={fieldClass} value={draft.due_date} onChange={(event) => setDraft((current) => ({ ...current, due_date: event.target.value }))} />
        </label>
        {invoice.recurring_commitment_id && (
          <label className="text-caption text-charcoal/70 sm:col-span-2">Recurring payment due date
            <input type="date" className={fieldClass} value={draft.recurring_due_date} onChange={(event) => setDraft((current) => ({ ...current, recurring_due_date: event.target.value }))} />
            <span className="mt-2 block">Choose the scheduled payment this bill replaces. Linking it removes that occurrence from Planned outgoings so the expense is counted once.</span>
          </label>
        )}
      </fieldset>
      <p className="text-caption text-charcoal/60">Use the amount and date from your payment record. Invoice approval alone does not mark a bill paid.</p>
      {error && <p role="alert" className="text-body text-red-800">{error}</p>}
      <div className="flex items-center gap-4">
        <button type="submit" disabled={saving} className="border border-nearblack bg-nearblack px-4 py-2 text-caption text-white disabled:opacity-50">{saving ? "Saving…" : "Save payment"}</button>
        <button type="button" disabled={saving} onClick={onCancel} className="px-2 py-2 text-caption text-charcoal/70 disabled:opacity-50">Cancel</button>
      </div>
    </form>
  );
}

export function FinanceCompanyInvoicesPanel({ onChanged, focusInvoiceId }: {
  onChanged?: () => void | Promise<void>;
  focusInvoiceId?: string | null;
} = {}) {
  const [invoices, setInvoices] = useState<CompanyInvoice[]>([]);
  const [canEditPayment, setCanEditPayment] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const appliedFocusId = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/finance/company-invoices${focusInvoiceId ? `?invoice=${encodeURIComponent(focusInvoiceId)}` : ""}`, { cache: "no-store" });
      const body = await response.json() as { invoices?: CompanyInvoice[]; can_edit_payment?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load company bills");
      setInvoices(body.invoices ?? []);
      setCanEditPayment(body.can_edit_payment === true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load company bills");
    } finally {
      setLoading(false);
    }
  }, [focusInvoiceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!focusInvoiceId) {
      appliedFocusId.current = null;
      return;
    }
    if (loading || appliedFocusId.current === focusInvoiceId) return;
    const invoice = invoices.find((item) => item.id === focusInvoiceId);
    if (!invoice) return;
    const timer = window.setTimeout(() => {
      appliedFocusId.current = focusInvoiceId;
      if (canEditPayment && invoice.status === "approved") setEditingInvoiceId(invoice.id);
      const row = document.getElementById(`company-invoice-${invoice.id}`);
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
      row?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusInvoiceId, invoices, loading, canEditPayment]);

  return (
    <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="company-bills-heading">
      <div className="border-b border-charcoal/20 p-5 md:p-7">
        <p className="label-caps">Company expenses</p>
        <h2 id="company-bills-heading" className="mt-2 font-display text-section text-nearblack">Office and recurring bills</h2>
        <p className="mt-2 max-w-2xl text-body text-charcoal/60">
          Every verified supplier invoice can be captured before its job is known. Unallocated bills stay visible here until you tell Stuart which project they belong to or confirm that they are a company expense.
        </p>
      </div>
      {error && <div role="alert" className="border-b border-red-700/30 bg-red-50 p-4 text-body text-red-800">{error}</div>}
      {notice && <div role="status" className="border-b border-charcoal/20 p-4 text-body text-charcoal">{notice}</div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-left">
          <thead className="bg-nearblack text-white"><tr className="text-[7px] uppercase tracking-[0.14em]"><th className="px-5 py-3">Supplier</th><th className="px-5 py-3">Invoice</th><th className="px-5 py-3">Category</th><th className="px-5 py-3">Recurring commitment</th><th className="px-5 py-3 text-right">Total</th><th className="px-5 py-3">Payment</th></tr></thead>
          <tbody className="divide-y divide-charcoal/10">
            {invoices.map((invoice) => (
              <Fragment key={invoice.id}>
              <tr id={`company-invoice-${invoice.id}`} tabIndex={-1} className={`scroll-mt-24 text-body hover:bg-cream focus:outline-none ${focusInvoiceId === invoice.id ? "bg-amber-50 ring-1 ring-inset ring-amber-700/40" : ""}`}>
                <td className="px-5 py-4 text-nearblack">{invoice.supplier}</td>
                <td className="px-5 py-4"><span className="block text-nearblack">{invoice.invoice_number}</span><span className="mt-1 block text-caption text-charcoal/60">Issued {dateLabel(invoice.invoice_date)}</span><span className="mt-1 block text-caption text-charcoal/60">Due {dateLabel(invoice.due_date)}</span></td>
                <td className="px-5 py-4">{invoice.expense_scope === "unallocated" ? "Unallocated — job or company pending" : label(invoice.company_expense_category ?? "other")}</td>
                <td className="px-5 py-4">{invoice.finance_recurring_commitments?.name ?? "Not linked"}
                  {invoice.recurring_due_date && <span className="mt-1 block text-caption text-charcoal/60">Replaces {dateLabel(invoice.recurring_due_date)}</span>}
                  {invoice.status === "approved" && invoice.recurring_commitment_id && !invoice.recurring_due_date && <span className="mt-1 block text-caption text-amber-800">Needs recurring payment date — scheduled expense may still be counted.</span>}
                </td>
                <td className="px-5 py-4 text-right text-nearblack">{money(Number(invoice.total), invoice.currency_code)}</td>
                <td className="px-5 py-4">
                  <span className={`inline-block border px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] ${invoice.payment_status === "paid" ? "border-green-800/30 text-green-800" : "border-charcoal/25"}`}>{label(invoice.payment_status ?? "unpaid")}</span>
                  <span className="mt-2 block text-caption text-charcoal/70">{money(Math.max(0, Number(invoice.total) - Number(invoice.amount_paid ?? 0)), invoice.currency_code)} remaining</span>
                  {Number(invoice.amount_paid) > 0 && <span className="mt-1 block text-caption text-charcoal/60">{money(Number(invoice.amount_paid), invoice.currency_code)} paid · {dateLabel(invoice.paid_at)}</span>}
                  {invoice.status !== "approved" && <span className="mt-1 block text-caption text-charcoal/60">Invoice {label(invoice.status).toLowerCase()}</span>}
                  {canEditPayment && invoice.status === "approved" && <button type="button" aria-expanded={editingInvoiceId === invoice.id} aria-controls={`company-invoice-payment-${invoice.id}`} onClick={() => { setNotice(null); setEditingInvoiceId(editingInvoiceId === invoice.id ? null : invoice.id); }} className="mt-2 border border-charcoal/30 px-3 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white">{invoice.payment_status === "unpaid" ? "Record payment" : "Edit payment"}</button>}
                </td>
              </tr>
              {canEditPayment && invoice.status === "approved" && editingInvoiceId === invoice.id && <tr id={`company-invoice-payment-${invoice.id}`}><td colSpan={6} className="border-y border-charcoal/20 bg-cream px-5 py-5">
                <CompanyInvoicePaymentEditor invoice={invoice} onCancel={() => setEditingInvoiceId(null)} onSaved={async (payment) => {
                  setInvoices((current) => current.map((item) => item.id === invoice.id ? { ...item, ...payment } : item));
                  setEditingInvoiceId(null);
                  setNotice(`Payment saved for ${invoice.supplier} invoice ${invoice.invoice_number}.`);
                  try { await onChanged?.(); } catch { setError("Payment saved, but the forecast could not refresh. Refresh Finance to see the updated cashflow."); }
                }} />
              </td></tr>}
              </Fragment>
            ))}
            {!loading && invoices.length === 0 && <tr><td colSpan={6} className="px-5 py-12 text-center text-body text-charcoal/50">No company or unallocated bills have been staged yet.</td></tr>}
            {loading && <tr><td colSpan={6} className="px-5 py-12 text-center text-body text-charcoal/50">Loading company bills…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
