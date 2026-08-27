"use client";

import { useCallback, useEffect, useState } from "react";
import { dollarsInputToMinor, formatMinorCurrency } from "@/lib/finance/presentation";
import type {
  FinanceCreditFacilitiesResponse,
  FinanceCreditFacility,
  FinanceCreditFacilityType,
} from "@/types/finance";

const TYPES: Array<[FinanceCreditFacilityType, string]> = [
  ["overdraft", "Overdraft"],
  ["credit_card", "Credit card"],
  ["line_of_credit", "Line of credit"],
  ["other", "Other facility"],
];

type Form = {
  id: string | null;
  version: number | null;
  xeroAccountId: string;
  type: FinanceCreditFacilityType;
  limit: string;
  rate: string;
  status: "active" | "paused" | "closed";
  notes: string;
  reason: string;
};

const blankForm = (): Form => ({
  id: null,
  version: null,
  xeroAccountId: "",
  type: "credit_card",
  limit: "",
  rate: "",
  status: "active",
  notes: "",
  reason: "Add credit facility to liquidity view",
});

function fromFacility(item: FinanceCreditFacility): Form {
  return {
    id: item.id,
    version: item.version,
    xeroAccountId: item.xero_bank_account_id,
    type: item.facility_type,
    limit: (item.credit_limit_minor / 100).toFixed(2),
    rate: item.interest_rate_bps === null ? "" : (item.interest_rate_bps / 100).toString(),
    status: item.status,
    notes: item.notes ?? "",
    reason: "Update credit facility limit",
  };
}

export function FinanceCreditFacilitiesPanel({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const [data, setData] = useState<FinanceCreditFacilitiesResponse | null>(null);
  const [form, setForm] = useState<Form>(blankForm);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/finance/credit-facilities", { cache: "no-store" });
      const body = (await response.json()) as FinanceCreditFacilitiesResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load credit facilities");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load credit facilities");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  function patch<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const limit = dollarsInputToMinor(form.limit);
    const rate = form.rate.trim() ? Number(form.rate) : null;
    if (!limit || limit <= 0) {
      setError("Enter a positive credit limit.");
      return;
    }
    if (!form.xeroAccountId) {
      setError("Choose the matching Xero account.");
      return;
    }
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1000)) {
      setError("Interest rate must be between 0 and 1,000%.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/finance/credit-facilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: form.id,
          expected_version: form.version,
          xero_bank_account_id: form.xeroAccountId,
          facility_type: form.type,
          credit_limit_minor: limit,
          interest_rate_bps: rate === null ? null : Math.round(rate * 100),
          status: form.status,
          notes: form.notes || null,
          reason: form.reason,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save credit facility");
      setForm(blankForm());
      setShowForm(false);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save credit facility");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-charcoal/20 bg-offwhite">
      <div className="flex flex-col gap-4 border-b border-charcoal/20 p-5 md:flex-row md:items-end md:justify-between md:p-7">
        <div>
          <p className="label-caps">Liquidity facilities</p>
          <h2 className="mt-2 font-display text-section text-nearblack">Overdrafts and credit cards</h2>
          <p className="mt-2 max-w-2xl text-body text-charcoal/60">Choose the matching Xero account and enter its facility limit. Every current balance is read from Xero; there is no balance to maintain here.</p>
        </div>
        {canEdit && <button type="button" onClick={() => { setForm(blankForm()); setShowForm((value) => !value); }} className="bg-nearblack px-4 py-2 text-subhead text-white">{showForm ? "Close" : "Add facility"}</button>}
      </div>
      {error && <div role="alert" className="border-b border-red-700/30 bg-red-50 p-4 text-body text-red-800">{error}</div>}
      {showForm && canEdit && (
        <form className="grid gap-4 border-b border-charcoal/20 bg-cream p-5 md:grid-cols-2 xl:grid-cols-4 md:p-7" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="md:col-span-2"><span className="label-caps">Xero account</span><select required value={form.xeroAccountId} onChange={(event) => { const account = data?.xero_accounts.find((item) => item.id === event.target.value); patch("xeroAccountId", event.target.value); if (account?.bank_account_type === "CREDITCARD") patch("type", "credit_card"); else if (form.type === "credit_card") patch("type", "overdraft"); }} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"><option value="">Select Xero account</option>{(data?.xero_accounts ?? []).filter((account) => !data?.facilities.some((facility) => facility.xero_bank_account_id === account.id && facility.id !== form.id)).map((account) => <option key={account.id} value={account.id}>{account.name} — Xero {formatMinorCurrency(account.balance_minor)}</option>)}</select></label>
          <label><span className="label-caps">Type</span><select value={form.type} disabled={data?.xero_accounts.find((item) => item.id === form.xeroAccountId)?.bank_account_type === "CREDITCARD"} onChange={(event) => patch("type", event.target.value as FinanceCreditFacilityType)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body disabled:opacity-60">{TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span className="label-caps">Status</span><select value={form.status} onChange={(event) => patch("status", event.target.value as Form["status"])} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option></select></label>
          <label><span className="label-caps">Credit limit</span><input required inputMode="decimal" value={form.limit} onChange={(event) => patch("limit", event.target.value)} placeholder="0.00" className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
          <label><span className="label-caps">Interest rate % (optional)</span><input inputMode="decimal" value={form.rate} onChange={(event) => patch("rate", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
          <label><span className="label-caps">Notes</span><input value={form.notes} onChange={(event) => patch("notes", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
          <label className="md:col-span-2"><span className="label-caps">Change reason</span><input required value={form.reason} onChange={(event) => patch("reason", event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" /></label>
          <div className="flex items-end gap-3 md:col-span-2"><button type="submit" disabled={saving} className="bg-nearblack px-5 py-2 text-subhead text-white disabled:opacity-40">{saving ? "Saving…" : form.id ? "Save facility" : "Add facility"}</button></div>
        </form>
      )}
      <div className="grid sm:grid-cols-4">
        {[["Active facilities", String(data?.summary.active_count ?? "—")], ["Total limits", formatMinorCurrency(data?.summary.credit_limit_minor ?? 0)], ["Xero facility debt", formatMinorCurrency(data?.summary.current_balance_minor ?? 0)], ["Available credit", formatMinorCurrency(data?.summary.available_credit_minor ?? 0)]].map(([label, value]) => <div key={label} className="border-b border-r border-charcoal/15 p-4 last:border-r-0 sm:border-b-0"><p className="label-caps">{label}</p><p className="mt-2 text-subhead text-nearblack">{value}</p></div>)}
      </div>
      <div className="divide-y divide-charcoal/10 border-t border-charcoal/20">
        {(data?.facilities ?? []).map((item) => <button key={item.id} type="button" disabled={!canEdit} onClick={() => { setForm(fromFacility(item)); setShowForm(true); }} className="grid w-full gap-2 px-5 py-4 text-left hover:bg-cream sm:grid-cols-[1fr_auto] sm:items-center"><span><span className="block text-body text-nearblack">{item.xero_account_name}</span><span className="text-caption text-charcoal/50">Xero balance {formatMinorCurrency(item.xero_balance_minor)} · {TYPES.find(([value]) => value === item.facility_type)?.[1]}</span></span><span className="text-right"><span className="block text-subhead text-nearblack">{formatMinorCurrency(item.credit_limit_minor)} limit</span><span className="text-caption text-charcoal/50">{formatMinorCurrency(item.available_credit_minor)} available</span></span></button>)}
        {!loading && (data?.facilities.length ?? 0) === 0 && <p className="px-5 py-10 text-center text-body text-charcoal/50">No credit facilities entered yet.</p>}
      </div>
    </section>
  );
}
