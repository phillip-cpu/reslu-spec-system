"use client";

import { useState } from "react";
import type { InvoiceBankDetails } from "@/types/client-invoices";

interface Props {
  initialBankDetails: InvoiceBankDetails | null;
  canEdit: boolean;
}

/**
 * Bank transfer details shown on every client invoice PDF/email
 * (BUILD-SPEC.md DECISIONS: "bank transfer standard ... construction-
 * sized amounts — card fees prohibitive"). Backed by GET/PUT
 * /api/settings/bank-details (app_settings key 'invoice_bank_details').
 * Single-object form, not a list — the closest structural precedent in
 * this codebase (ExportPresetSettings.tsx / PhaseTemplateSettings.tsx)
 * edits an ARRAY of rows; this is deliberately simpler (one row, no
 * add/remove) since only one set of bank details exists at a time.
 *
 * NEVER pre-fills a guessed/placeholder account number — initialBankDetails
 * is null until an admin has saved real values here at least once (see
 * lib/bank-details.ts's header comment). While null, every invoice PDF
 * prints "Bank details not configured" instead of a payment panel.
 */
export function BankDetailsSettings({ initialBankDetails, canEdit }: Props) {
  const [accountName, setAccountName] = useState(initialBankDetails?.account_name ?? "");
  const [bsb, setBsb] = useState(initialBankDetails?.bsb ?? "");
  const [accountNumber, setAccountNumber] = useState(initialBankDetails?.account_number ?? "");
  const [saved, setSaved] = useState(initialBankDetails !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!accountName.trim() || !bsb.trim() || !accountNumber.trim()) {
      setError("Account name, BSB and account number are all required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/bank-details", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_name: accountName.trim(),
          bsb: bsb.trim(),
          account_number: accountNumber.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save bank details");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save bank details");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-3">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>
      )}
      {!saved && (
        <p className="border border-sand/40 bg-cream px-3 py-2 text-caption text-charcoal/70">
          Not configured yet — every client invoice PDF will show &quot;Bank details not
          configured&quot; until this is saved.
        </p>
      )}
      <form onSubmit={save} className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <p className="label-caps mb-1">Account name</p>
            <input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              disabled={!canEdit}
              className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="block">
            <p className="label-caps mb-1">BSB</p>
            <input
              value={bsb}
              onChange={(e) => setBsb(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 065-000"
              className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="block">
            <p className="label-caps mb-1">Account number</p>
            <input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              disabled={!canEdit}
              className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
        </div>
        {canEdit && (
          <button
            type="submit"
            disabled={saving}
            className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save bank details"}
          </button>
        )}
      </form>
    </div>
  );
}
