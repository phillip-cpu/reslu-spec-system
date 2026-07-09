"use client";

import { useState } from "react";
import type { CpdDefaults } from "@/types/cpd";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  initialDefaults: CpdDefaults;
  canEdit: boolean;
}

/**
 * CPD tracker studio-wide defaults (migration 047) — annual point
 * target and licence-year start month. Backed by GET/PUT
 * /api/settings/cpd-defaults (app_settings key 'cpd_defaults').
 * Single-object form, same structural shape as BankDetailsSettings.tsx
 * (one row, no add/remove) — not a list editor like
 * ExportPresetSettings/PhaseTemplateSettings.
 *
 * Per-user override is EXPLICITLY OUT of scope for v1 — see lib/cpd.ts's
 * FALLBACK_CPD_DEFAULTS doc comment for the extension point. This form
 * always edits the ONE studio-wide row every team member's /cpd page
 * reads from.
 */
export function CpdDefaultsSettings({ initialDefaults, canEdit }: Props) {
  const [annualTarget, setAnnualTarget] = useState(String(initialDefaults.annual_target));
  const [yearStartMonth, setYearStartMonth] = useState(initialDefaults.year_start_month);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const target = Number(annualTarget);
    if (!Number.isFinite(target) || target <= 0) {
      setError("Annual target must be a positive number.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/cpd-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annual_target: target, year_start_month: yearStartMonth }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save CPD defaults");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save CPD defaults");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-3">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>
      )}
      {saved && (
        <p className="border border-sand/40 bg-cream px-3 py-2 text-caption text-charcoal/70">Saved.</p>
      )}
      <form onSubmit={save} className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <p className="label-caps mb-1">Annual target (points)</p>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={annualTarget}
              onChange={(e) => setAnnualTarget(e.target.value)}
              disabled={!canEdit}
              className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="block">
            <p className="label-caps mb-1">Licence year starts</p>
            <select
              value={yearStartMonth}
              onChange={(e) => setYearStartMonth(Number(e.target.value))}
              disabled={!canEdit}
              className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            >
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {canEdit && (
          <button
            type="submit"
            disabled={saving}
            className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save CPD defaults"}
          </button>
        )}
      </form>
    </div>
  );
}
