"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { FinanceRecurringOccurrence } from "@/lib/finance/recurrence";
import {
  dollarsInputToMinor,
  formatFinanceDate,
  formatMinorCurrency,
} from "@/lib/finance/presentation";
import type {
  FinanceConfidence,
  FinanceGstTreatment,
  FinanceRecurringCategory,
  FinanceRecurringCommitment,
  FinanceRecurringCommitmentsResponse,
  FinanceRecurringFrequency,
} from "@/types/finance";

const CATEGORY_OPTIONS: Array<[FinanceRecurringCategory, string]> = [
  ["wages", "Wages"],
  ["superannuation", "Superannuation"],
  ["rent", "Rent"],
  ["marketing", "Marketing"],
  ["entertainment", "Entertainment"],
  ["software", "Software"],
  ["insurance", "Insurance"],
  ["utilities", "Utilities"],
  ["professional_fees", "Professional fees"],
  ["vehicles", "Vehicles"],
  ["other", "Other"],
];

const FREQUENCY_OPTIONS: Array<[FinanceRecurringFrequency, string]> = [
  ["once", "One-time"],
  ["weekly", "Weekly"],
  ["fortnightly", "Fortnightly"],
  ["monthly", "Monthly"],
  ["quarterly", "Quarterly"],
  ["annually", "Annually"],
];

type FormState = {
  id: string | null;
  expectedVersion: number | null;
  name: string;
  category: FinanceRecurringCategory;
  supplier: string;
  amount: string;
  frequency: FinanceRecurringFrequency;
  firstDueDate: string;
  endDate: string;
  gstTreatment: FinanceGstTreatment;
  escalationPercent: string;
  confidence: FinanceConfidence;
  status: "draft" | "active" | "paused";
  notes: string;
  reason: string;
};

type PaymentOccurrence = FinanceRecurringOccurrence & {
  linked_invoice_id: string | null;
  commitment_version: number;
};
type PaymentRegister = FinanceRecurringCommitmentsResponse & {
  occurrences: PaymentOccurrence[];
  summary: FinanceRecurringCommitmentsResponse["summary"] & { linked_occurrence_count: number };
};

function blankForm(
  asOfDate: string,
  frequency: FinanceRecurringFrequency = "fortnightly"
): FormState {
  const isOneTime = frequency === "once";
  return {
    id: null,
    expectedVersion: null,
    name: "",
    category: isOneTime ? "marketing" : "wages",
    supplier: "",
    amount: "",
    frequency,
    firstDueDate: asOfDate,
    endDate: "",
    gstTreatment: "inclusive",
    escalationPercent: "0",
    confidence: "confirmed",
    status: "active",
    notes: "",
    reason: isOneTime
      ? "Add one-time expected outgoing"
      : "Add recurring company commitment",
  };
}

function formFromCommitment(item: FinanceRecurringCommitment): FormState {
  return {
    id: item.id,
    expectedVersion: item.version,
    name: item.name,
    category: item.category,
    supplier: item.supplier_or_payee ?? "",
    amount: (item.amount_minor / 100).toFixed(2),
    frequency: item.frequency,
    firstDueDate: item.first_due_date,
    endDate: item.end_date ?? "",
    gstTreatment: item.gst_treatment,
    escalationPercent: (item.annual_escalation_bps / 100).toString(),
    confidence: item.confidence,
    status: item.status === "archived" ? "paused" : item.status,
    notes: item.notes ?? "",
    reason: item.frequency === "once"
      ? "Update one-time expected outgoing"
      : "Update recurring company commitment",
  };
}

export function FinanceRecurringCommitmentsPanel({
  asOfDate,
  canEdit,
  onChanged,
  onOpenCompanyInvoice,
  focusCommitmentId,
  focusDueDate,
}: {
  asOfDate: string;
  canEdit: boolean;
  onChanged: () => void;
  onOpenCompanyInvoice?: (invoiceId: string) => void;
  focusCommitmentId?: string | null;
  focusDueDate?: string | null;
}) {
  const [data, setData] = useState<PaymentRegister | null>(null);
  const [form, setForm] = useState<FormState>(() => blankForm(asOfDate));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [paymentFor, setPaymentFor] = useState<PaymentOccurrence | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(asOfDate);
  const [paymentReason, setPaymentReason] = useState("");
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState<string | null>(null);
  const [paymentFilter, setPaymentFilter] = useState("");
  const [showPaid, setShowPaid] = useState(false);
  const [showAllWeeks, setShowAllWeeks] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/finance/recurring-payments?as_of_date=${encodeURIComponent(asOfDate)}`,
        { cache: "no-store" }
      );
      const body = (await response.json()) as PaymentRegister & {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not load recurring commitments");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load recurring commitments");
    } finally {
      setLoading(false);
    }
  }, [asOfDate]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!focusCommitmentId) return;
    const timer = window.setTimeout(() => {
      setPaymentFilter(focusCommitmentId);
      setShowAllWeeks(true);
      setShowPaid(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusCommitmentId, focusDueDate, data]);

  useEffect(() => {
    if (!focusCommitmentId || !focusDueDate || !showAllWeeks) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`recurring-occurrence-${focusCommitmentId}-${focusDueDate}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusCommitmentId, focusDueDate, showAllWeeks, paymentFilter, data]);

  const nearbyEnd = new Date(`${asOfDate}T00:00:00Z`);
  nearbyEnd.setUTCDate(nearbyEnd.getUTCDate() + 13);
  const visibleOccurrences = (data?.occurrences ?? []).filter((item) =>
    (!paymentFilter || item.commitment_id === paymentFilter) &&
    (showPaid || item.linked_invoice_id || item.remaining_minor > 0) &&
    (showAllWeeks || item.due_date <= nearbyEnd.toISOString().slice(0, 10))
  );

  function openPayment(item: PaymentOccurrence) {
    setPaymentFor(item);
    setPaymentAmount((item.remaining_minor / 100).toFixed(2));
    setPaymentDate(asOfDate);
    setPaymentReason("");
    setPaymentSuccess(null);
  }

  async function recordPayment() {
    if (!paymentFor) return;
    const amount = dollarsInputToMinor(paymentAmount);
    if (!amount || amount <= 0 || amount > paymentFor.remaining_minor) {
      setError("Enter a payment greater than zero and no more than the remaining amount.");
      return;
    }
    setPaymentSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/finance/recurring-payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitment_id: paymentFor.commitment_id, due_date: paymentFor.due_date,
          amount_minor: amount, paid_on: paymentDate, reason: paymentReason,
          expected_version: paymentFor.payment_version,
          expected_commitment_version: paymentFor.commitment_version }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not record payment");
      setPaymentSuccess(`Payment recorded for ${paymentFor.name}. The outstanding forecast has been updated.`);
      setPaymentFor(null);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record payment");
    } finally { setPaymentSaving(false); }
  }

  async function undoPayment(item: PaymentOccurrence) {
    const reason = window.prompt(`Undo the last recorded payment for ${item.name}? This corrects the record; it does not refund money. Enter the correction reason:`);
    if (!reason?.trim()) return;
    setPaymentSaving(true);
    setError(null);
    setPaymentSuccess(null);
    try {
      const response = await fetch("/api/finance/recurring-payments", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitment_id: item.commitment_id, due_date: item.due_date,
          expected_version: item.payment_version, expected_commitment_version: item.commitment_version, reason }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not correct payment");
      setPaymentFor(null);
      setPaymentSuccess(`Last payment record for ${item.name} was undone. Its evidence remains in the audit history; no money was refunded.`);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not correct payment");
    } finally { setPaymentSaving(false); }
  }

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const amountMinor = dollarsInputToMinor(form.amount);
    const isOneTime = form.frequency === "once";
    const escalation = isOneTime ? 0 : Number(form.escalationPercent);
    if (!amountMinor || amountMinor <= 0) {
      setError("Enter a cash amount greater than zero.");
      return;
    }
    if (!Number.isFinite(escalation) || escalation < 0 || escalation > 100) {
      setError("Annual escalation must be between 0 and 100%.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/finance/recurring-commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: form.id,
          expected_version: form.expectedVersion,
          name: form.name,
          category: form.category,
          supplier_or_payee: form.supplier || null,
          amount_minor: amountMinor,
          frequency: form.frequency,
          first_due_date: form.firstDueDate,
          end_date: isOneTime ? null : form.endDate || null,
          gst_treatment: form.gstTreatment,
          annual_escalation_bps: Math.round(escalation * 100),
          confidence: form.confidence,
          status: form.status,
          notes: form.notes || null,
          reason: form.reason,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save commitment");
      setForm(blankForm(asOfDate));
      setShowForm(false);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save commitment");
    } finally {
      setSaving(false);
    }
  }

  async function archive(item: FinanceRecurringCommitment) {
    const reason = window.prompt(`Why are you archiving ${item.name}?`);
    if (!reason?.trim()) return;
    setError(null);
    const response = await fetch(`/api/finance/recurring-commitments/${item.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_version: item.version, reason }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not archive commitment");
      return;
    }
    await load();
    onChanged();
  }

  return (
    <div className="space-y-5">
      <section className="border border-charcoal/20 bg-offwhite">
        <div className="flex flex-col gap-4 border-b border-charcoal/20 p-5 md:flex-row md:items-end md:justify-between md:p-7">
          <div>
            <p className="label-caps">Company overheads</p>
            <h2 className="mt-2 font-display text-section text-nearblack">Planned company outgoings</h2>
            <p className="mt-2 max-w-2xl text-body text-charcoal/60">
              Add repeating commitments or one-time purchases. Record each payment below; only the unpaid amount stays in the forecast.
            </p>
          </div>
          {canEdit && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {showForm ? (
                <button type="button" onClick={() => setShowForm(false)} className="border border-charcoal/25 px-4 py-2 text-subhead text-nearblack hover:bg-cream">Close</button>
              ) : (
                <>
                  <button type="button" onClick={() => { setForm(blankForm(asOfDate, "once")); setShowForm(true); }} className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal">Add one-time outgoing</button>
                  <button type="button" onClick={() => { setForm(blankForm(asOfDate)); setShowForm(true); }} className="border border-charcoal/25 px-4 py-2 text-subhead text-nearblack hover:bg-cream">Add recurring commitment</button>
                </>
              )}
            </div>
          )}
        </div>

        {error && <div role="alert" className="border-b border-red-700/30 bg-red-50 p-4 text-body text-red-800">{error}</div>}
        {paymentSuccess && <div role="status" className="border-b border-[#304b33]/20 bg-[#304b33]/5 p-4 text-body text-[#304b33]">{paymentSuccess}</div>}

        {showForm && canEdit && (
          <form
            className="grid gap-4 border-b border-charcoal/20 bg-cream p-5 md:grid-cols-2 xl:grid-cols-4 md:p-7"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="xl:col-span-2"><span className="label-caps">Name</span><input required value={form.name} onChange={(event) => patchForm("name", event.target.value)} placeholder={form.frequency === "once" ? "e.g. Marketing campaign" : "e.g. Fortnightly wages"} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
            <label><span className="label-caps">Category</span><select value={form.category} onChange={(event) => patchForm("category", event.target.value as FinanceRecurringCategory)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body">{CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span className="label-caps">Supplier / payee</span><input value={form.supplier} onChange={(event) => patchForm("supplier", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
            <label><span className="label-caps">{form.frequency === "once" ? "Expected cash amount" : "Cash amount each time"}</span><input required inputMode="decimal" value={form.amount} onChange={(event) => patchForm("amount", event.target.value)} placeholder="0.00" className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
            <label><span className="label-caps">Frequency</span><select value={form.frequency} onChange={(event) => patchForm("frequency", event.target.value as FinanceRecurringFrequency)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body">{FREQUENCY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span className="label-caps">{form.frequency === "once" ? "Expected payment date" : "First / anchor due date"}</span><input required type="date" value={form.firstDueDate} onChange={(event) => patchForm("firstDueDate", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
            {form.frequency !== "once" && <label><span className="label-caps">End date (optional)</span><input type="date" value={form.endDate} onChange={(event) => patchForm("endDate", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>}
            <label><span className="label-caps">GST treatment</span><select value={form.gstTreatment} onChange={(event) => patchForm("gstTreatment", event.target.value as FinanceGstTreatment)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"><option value="inclusive">GST inclusive</option><option value="exclusive">GST exclusive</option><option value="gst_free">GST free</option><option value="not_applicable">Not applicable</option></select></label>
            {form.frequency !== "once" && <label><span className="label-caps">Annual escalation %</span><input inputMode="decimal" value={form.escalationPercent} onChange={(event) => patchForm("escalationPercent", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>}
            <label><span className="label-caps">Status</span><select value={form.status} onChange={(event) => patchForm("status", event.target.value as FormState["status"])} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"><option value="active">Active</option><option value="draft">Draft</option><option value="paused">Paused</option></select></label>
            <label><span className="label-caps">Confidence</span><select value={form.confidence} onChange={(event) => patchForm("confidence", event.target.value as FinanceConfidence)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"><option value="confirmed">Confirmed</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="unknown">Unknown</option></select></label>
            <label className="md:col-span-2"><span className="label-caps">Notes</span><input value={form.notes} onChange={(event) => patchForm("notes", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
            <label className="md:col-span-2"><span className="label-caps">Change reason</span><input required value={form.reason} onChange={(event) => patchForm("reason", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
            <div className="flex items-end gap-3 md:col-span-2">
              <button type="submit" disabled={saving} className="bg-nearblack px-5 py-2 text-subhead text-white disabled:opacity-40">{saving ? "Saving…" : form.id ? "Save changes" : "Add to forecast"}</button>
              {form.id && <button type="button" onClick={() => { setForm(blankForm(asOfDate)); setShowForm(false); }} className="border-b border-charcoal/30 text-body">Cancel</button>}
            </div>
          </form>
        )}

        <div className="grid grid-cols-1 border-b border-charcoal/20 sm:grid-cols-3">
          <div className="border-b border-charcoal/15 p-4 sm:border-b-0 sm:border-r"><p className="label-caps">Active</p><p className="mt-2 text-subhead text-nearblack">{data?.summary.active_count ?? "—"}</p></div>
          <div className="border-b border-charcoal/15 p-4 sm:border-b-0 sm:border-r"><p className="label-caps">{data?.summary.linked_occurrence_count ? "Unlinked planned outgoings" : "13-week unpaid outflow"}</p><p className="mt-2 text-subhead text-nearblack">{data ? formatMinorCurrency(data.summary.projected_outflow_minor) : "—"}</p>{Boolean(data?.summary.linked_occurrence_count) && <p className="mt-1 text-caption text-charcoal/50">Linked bills are reconciled in the cash timeline, not counted again here.</p>}</div>
          <div className="p-4"><p className="label-caps">Next due</p><p className="mt-2 text-subhead text-nearblack">{formatFinanceDate(data?.summary.next_due_date)}</p></div>
        </div>

        <div className="border-b border-charcoal/20 p-5 md:p-7">
          <h3 className="font-display text-xl text-nearblack">Payments — what is still owing</h3>
          <p className="mt-2 max-w-3xl text-body text-charcoal/60">An overdue date is not proof of payment. Tracked occurrences stay here until you record what was paid. If a company bill is linked, update the payment on that bill.</p>
          <p className="mt-1 text-caption text-charcoal/50">Tracking starts on each commitment’s tracking date. Earlier unrecorded occurrences have not been marked paid or added as new debts.</p>
          <div className="my-4 flex flex-wrap items-center gap-4 text-caption">
            <label><span className="sr-only">Filter outgoing</span><select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)} className="border border-charcoal/20 bg-offwhite px-3 py-2"><option value="">All outgoings</option>{(data?.commitments ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={showPaid} onChange={(event) => setShowPaid(event.target.checked)} />Include paid occurrences</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={showAllWeeks} onChange={(event) => setShowAllWeeks(event.target.checked)} />Show all 13 weeks</label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-left">
              <thead><tr className="border-b border-charcoal/20 text-caption text-charcoal/60"><th className="py-3 pr-3">Outgoing / due</th><th className="p-3 text-right">Expected</th><th className="p-3 text-right">Paid</th><th className="p-3 text-right">Still owing</th><th className="p-3">Action</th></tr></thead>
              <tbody>
                {visibleOccurrences.map((item) => <Fragment key={`${item.commitment_id}:${item.due_date}`}>
                  <tr id={`recurring-occurrence-${item.commitment_id}-${item.due_date}`} className={`border-b border-charcoal/10 text-body ${focusCommitmentId === item.commitment_id && focusDueDate === item.due_date ? "bg-amber-50 ring-1 ring-inset ring-amber-500/40" : ""}`}>
                    <td className="py-3 pr-3">{item.name}<span className={`mt-1 block text-caption ${!item.linked_invoice_id && item.remaining_minor > 0 && item.due_date < asOfDate ? "text-amber-800" : "text-charcoal/50"}`}>{formatFinanceDate(item.due_date)}{!item.linked_invoice_id && item.remaining_minor > 0 && item.due_date < asOfDate ? " · overdue, not marked paid" : ""}</span></td>
                    <td className="p-3 text-right">{formatMinorCurrency(item.amount_minor)}</td>
                    <td className="p-3 text-right">{item.linked_invoice_id ? "—" : formatMinorCurrency(item.paid_minor)}</td>
                    <td className="p-3 text-right">{item.linked_invoice_id ? "—" : formatMinorCurrency(item.remaining_minor)}</td>
                    <td className="p-3">{item.linked_invoice_id
                      ? <button type="button" onClick={() => onOpenCompanyInvoice?.(item.linked_invoice_id!)} disabled={!onOpenCompanyInvoice} className="border-b border-charcoal/30 text-caption disabled:opacity-60">Managed on company bill</button>
                      : item.remaining_minor === 0 ? <span className="text-caption text-[#304b33]">Paid{item.paid_on ? ` · ${formatFinanceDate(item.paid_on)}` : ""}</span>
                      : canEdit ? <button type="button" disabled={paymentSaving} onClick={() => openPayment(item)} className="border border-charcoal/25 px-3 py-2 text-caption disabled:opacity-40">Record payment</button> : <span className="text-caption">{item.status === "part_paid" ? "Part paid" : "Unpaid"}</span>}
                      {canEdit && !item.linked_invoice_id && item.payment_entries.length > 0 && <button type="button" disabled={paymentSaving} onClick={() => void undoPayment(item)} className="mt-2 block border-b border-charcoal/30 text-caption text-charcoal/60 disabled:opacity-40">Undo last payment record</button>}</td>
                  </tr>
                  {paymentFor?.commitment_id === item.commitment_id && paymentFor.due_date === item.due_date && <tr><td colSpan={5} className="border-b border-charcoal/20 bg-cream p-4">
                    <form onSubmit={(event) => { event.preventDefault(); void recordPayment(); }} className="flex flex-wrap items-end gap-3">
                      <label><span className="block text-caption">Amount paid this time</span><input required inputMode="decimal" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="mt-1 w-36 border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
                      <label><span className="block text-caption">Actual payment date</span><input required type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} className="mt-1 border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
                      <label className="min-w-48 flex-1"><span className="block text-caption">Reference / note</span><input required value={paymentReason} onChange={(event) => setPaymentReason(event.target.value)} placeholder="Bank reference or payment note" className="mt-1 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
                      <button type="submit" disabled={paymentSaving} className="bg-nearblack px-4 py-2 text-body text-white disabled:opacity-40">{paymentSaving ? "Saving…" : "Save payment"}</button>
                      <button type="button" disabled={paymentSaving} onClick={() => setPaymentFor(null)} className="px-2 py-2 text-body">Cancel</button>
                      <p className="w-full text-caption text-charcoal/60">This records an existing payment; it does not transfer money. Each payment keeps its actual date.</p>
                    </form>
                  </td></tr>}
                </Fragment>)}
                {!loading && visibleOccurrences.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-body text-charcoal/50">No outstanding occurrences in this view.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead className="bg-nearblack text-white"><tr className="text-[7px] uppercase tracking-[0.14em]"><th className="px-5 py-3">Outgoing</th><th className="px-5 py-3">Category</th><th className="px-5 py-3 text-right">Cash amount</th><th className="px-5 py-3">Schedule</th><th className="px-5 py-3">Due / anchor date</th><th className="px-5 py-3">Status</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-charcoal/10">
              {(data?.commitments ?? []).map((item) => (
                <tr key={item.id} className="text-body hover:bg-cream">
                  <td className="px-5 py-4"><span className="block text-nearblack">{item.name}</span><span className="mt-1 block text-caption text-charcoal/45">{item.supplier_or_payee ?? "No payee"}</span></td>
                  <td className="px-5 py-4">{CATEGORY_OPTIONS.find(([value]) => value === item.category)?.[1]}</td>
                  <td className="px-5 py-4 text-right">{formatMinorCurrency(item.amount_minor)}</td>
                  <td className="px-5 py-4">{FREQUENCY_OPTIONS.find(([value]) => value === item.frequency)?.[1]}</td>
                  <td className="px-5 py-4">{formatFinanceDate(item.first_due_date)}</td>
                  <td className="px-5 py-4"><span className={`px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] ${item.status === "active" ? "bg-[#304b33]/10 text-[#304b33]" : "bg-charcoal/10 text-charcoal"}`}>{item.status}</span></td>
                  <td className="px-5 py-4 text-right">{canEdit && <span className="inline-flex gap-3"><button type="button" onClick={() => { setForm(formFromCommitment(item)); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="border-b border-charcoal/30 text-caption">Edit</button><button type="button" onClick={() => void archive(item)} className="border-b border-red-700/30 text-caption text-red-800">Archive</button></span>}</td>
                </tr>
              ))}
              {!loading && (data?.commitments.length ?? 0) === 0 && <tr><td colSpan={7} className="px-5 py-12 text-center text-body text-charcoal/50">No planned company outgoings yet. Add recurring costs or one-time purchases such as marketing and entertainment.</td></tr>}
              {loading && <tr><td colSpan={7} className="px-5 py-12 text-center text-body text-charcoal/50">Loading recurring commitments…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
