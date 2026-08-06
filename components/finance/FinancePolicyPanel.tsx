"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adelaideToday, formatFinanceDate } from "@/lib/finance/presentation";
import type { FinancePolicyVersion } from "@/types/finance";

type PolicyResponse = { policies?: FinancePolicyVersion[]; error?: string };

export function FinancePolicyPanel() {
  const [policies, setPolicies] = useState<FinancePolicyVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(adelaideToday);
  const [reason, setReason] = useState("");
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [accountantConfirmed, setAccountantConfirmed] = useState(false);
  const [legalConfirmed, setLegalConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const loadPolicies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/finance/policies", { cache: "no-store" });
      const body = (await response.json()) as PolicyResponse;
      if (!response.ok) throw new Error(body.error ?? "Could not load finance policy");
      setPolicies(body.policies ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load finance policy");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPolicies(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPolicies]);

  const draft = useMemo(
    () => policies.find((policy) => policy.status === "draft") ?? null,
    [policies]
  );
  const published = useMemo(
    () => policies.find((policy) => policy.status === "published") ?? null,
    [policies]
  );
  const allConfirmed = ownerConfirmed && accountantConfirmed && legalConfirmed;

  async function publish() {
    if (!draft || !allConfirmed || !reason.trim()) return;
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch(`/api/finance/policies/${draft.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_from: effectiveFrom,
          configuration: draft.configuration,
          confirmations: {
            owner: "confirmed",
            accountant: "confirmed",
            legal: "confirmed",
          },
          reason: reason.trim(),
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not publish finance policy");
      setReason("");
      setOwnerConfirmed(false);
      setAccountantConfirmed(false);
      setLegalConfirmed(false);
      await loadPolicies();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish finance policy");
    } finally {
      setPublishing(false);
    }
  }

  if (loading) {
    return <div className="border border-charcoal/15 bg-offwhite p-6 text-body text-charcoal/55">Loading finance governance…</div>;
  }

  return (
    <section aria-labelledby="finance-policy-title" className="space-y-5">
      <div className="border border-charcoal/20 bg-offwhite p-5 md:p-7">
        <p className="label-caps mb-2">Governance gate</p>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 id="finance-policy-title" className="font-display text-section text-nearblack">
              Finance calculation policy
            </h2>
            <p className="mt-2 max-w-2xl text-body text-charcoal/65">
              Activation remains blocked until the owner, accountant and legal decisions are recorded.
              Publishing freezes this version; later changes create a successor rather than rewriting history.
            </p>
          </div>
          <div className="border border-charcoal/15 bg-cream px-4 py-3 text-right">
            <p className="label-caps">Current</p>
            <p className="mt-1 text-subhead text-nearblack">
              {published ? `Published v${published.version_number}` : "No published policy"}
            </p>
            {published && <p className="mt-1 text-caption text-charcoal/55">Effective {formatFinanceDate(published.effective_from)}</p>}
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="border border-red-700/35 bg-red-50 px-4 py-3 text-body text-red-800">
          {error}
        </div>
      )}

      {!draft ? (
        <div className="border border-[#4c6b4f]/35 bg-[#4c6b4f]/5 p-6">
          <p className="text-subhead text-[#304b33]">The current finance policy is published.</p>
          <p className="mt-2 text-body text-charcoal/60">
            Project activation can now pass the policy gate when the remaining evidence is current.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
          <div className="border border-charcoal/20 bg-offwhite p-5 md:p-7">
            <div className="flex items-center justify-between gap-4 border-b border-charcoal/15 pb-4">
              <div>
                <p className="label-caps">Draft policy</p>
                <p className="mt-1 text-subhead text-nearblack">Version {draft.version_number}</p>
              </div>
              <span className="border border-[#c9971e] bg-[#c9971e]/10 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-[#76570a]">
                Not active
              </span>
            </div>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              {Object.entries(draft.configuration).map(([key, value]) => (
                <div key={key} className="border-b border-charcoal/10 pb-3">
                  <dt className="label-caps">{key.replaceAll("_", " ")}</dt>
                  <dd className="mt-1 break-words text-body text-nearblack">
                    {typeof value === "object" ? JSON.stringify(value) : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="border border-charcoal/20 bg-nearblack p-5 text-white md:p-7">
            <p className="label-caps text-sand">Controlled publication</p>
            <p className="mt-2 text-body text-white/65">
              Only confirm an approval after that person has reviewed the policy outside this screen.
            </p>
            <div className="mt-5 space-y-3">
              {[
                ["Owner decision recorded", ownerConfirmed, setOwnerConfirmed],
                ["Accountant decision recorded", accountantConfirmed, setAccountantConfirmed],
                ["Legal decision recorded", legalConfirmed, setLegalConfirmed],
              ].map(([label, checked, setter]) => (
                <label key={String(label)} className="flex cursor-pointer items-start gap-3 border border-white/20 p-3 text-body">
                  <input
                    type="checkbox"
                    checked={Boolean(checked)}
                    onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[#A08C72]"
                  />
                  <span>{String(label)}</span>
                </label>
              ))}
            </div>
            <label className="mt-5 block">
              <span className="label-caps text-sand">Effective from</span>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                className="mt-2 w-full border border-white/25 bg-charcoal px-3 py-2 text-body text-white"
              />
            </label>
            <label className="mt-4 block">
              <span className="label-caps text-sand">Publication reason</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                placeholder="Record the decision reference and why this version is approved."
                className="mt-2 w-full border border-white/25 bg-charcoal px-3 py-2 text-body text-white placeholder:text-white/35"
              />
            </label>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={!allConfirmed || !reason.trim() || publishing}
              className="mt-5 w-full bg-sand px-4 py-3 text-subhead text-nearblack transition-colors hover:bg-[#b09a7c] disabled:cursor-not-allowed disabled:opacity-35"
            >
              {publishing ? "Publishing…" : "Publish immutable policy"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
