"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FinanceCashCurve } from "./FinanceCashCurve";
import { FinanceStatePill } from "./FinanceStatePill";
import {
  adelaideToday,
  dollarsInputToMinor,
  formatFinanceDate,
  formatMinorCurrency,
} from "@/lib/finance/presentation";
import type {
  FinanceActivationReadiness,
  FinanceShadowProjectionResponse,
  ProjectFinanceResponse,
} from "@/types/finance";

type WorkspaceTab = "position" | "timing" | "activation";

type ApiError = { error?: string; readiness?: FinanceActivationReadiness };

function checkLabel(code: FinanceActivationReadiness["checks"][number]["code"]): string {
  return {
    signed_contract: "Signed contract",
    saved_estimate: "Approved estimate",
    dated_program: "Dated program",
    published_policy: "Published policy",
    lifecycle_state: "Lifecycle state",
  }[code];
}

export function ProjectFinanceWorkspace({ projectId }: { projectId: string }) {
  const [finance, setFinance] = useState<ProjectFinanceResponse | null>(null);
  const [shadow, setShadow] = useState<FinanceShadowProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("position");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [asOfDate, setAsOfDate] = useState(adelaideToday);
  const [openingCash, setOpeningCash] = useState("");
  const [timingOverrides, setTimingOverrides] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(adelaideToday);
  const [contractReference, setContractReference] = useState("");
  const [contractSignedAt, setContractSignedAt] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [readiness, setReadiness] = useState<FinanceActivationReadiness | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [activating, setActivating] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const loadFinance = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/finance`, { cache: "no-store" });
    const body = (await response.json()) as ProjectFinanceResponse & ApiError;
    if (!response.ok) throw new Error(body.error ?? "Could not load project finance");
    setFinance(body);
    return body;
  }, [projectId]);

  const calculatePreview = useCallback(
    async (profile: ProjectFinanceResponse | null, overrides: Record<string, string>) => {
      const openingMinor = dollarsInputToMinor(openingCash);
      if (openingCash.trim() && openingMinor === null) {
        throw new Error("Opening cash must be a dollar amount with no more than two decimal places.");
      }
      const response = await fetch(`/api/projects/${projectId}/finance/shadow-projection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          as_of_date: asOfDate,
          ...(openingMinor === null ? {} : { opening_cash_minor: openingMinor }),
          ...(profile?.finance.active_baseline?.estimate_version_id
            ? { estimate_version_id: profile.finance.active_baseline.estimate_version_id }
            : {}),
          timing_overrides: overrides,
        }),
      });
      const body = (await response.json()) as FinanceShadowProjectionResponse & ApiError;
      if (!response.ok) throw new Error(body.error ?? "Could not calculate project shadow forecast");
      setShadow(body);
      setSelectedIndex((current) =>
        current < body.projection.periods.length ? current : 0
      );
    },
    [asOfDate, openingCash, projectId]
  );

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profile = await loadFinance();
      await calculatePreview(profile, timingOverrides);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load project finance");
    } finally {
      setLoading(false);
    }
  }, [calculatePreview, loadFinance, timingOverrides]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Initial snapshot only; draft timing changes require explicit recalculation.

  const uniqueLines = useMemo(() => {
    const byKey = new Map<string, FinanceShadowProjectionResponse["projection"]["effectiveContributions"][number]>();
    for (const contribution of shadow?.projection.effectiveContributions ?? []) {
      if (!byKey.has(contribution.contributionKey)) byKey.set(contribution.contributionKey, contribution);
    }
    return [...byKey.values()].sort((a, b) => {
      const sectionA = String(a.sourceTrace.section_name ?? "ZZZ");
      const sectionB = String(b.sourceTrace.section_name ?? "ZZZ");
      return sectionA.localeCompare(sectionB) || a.description.localeCompare(b.description);
    });
  }, [shadow]);

  const sectionTotals = useMemo(() => {
    const totals = new Map<string, { amount: number; count: number; unknown: number }>();
    for (const line of uniqueLines) {
      const section = String(line.sourceTrace.section_name ?? line.sourceTrace.category ?? "Other");
      const current = totals.get(section) ?? { amount: 0, count: 0, unknown: 0 };
      current.amount += line.amountMinor;
      current.count += 1;
      if (!line.effectiveDate) current.unknown += line.amountMinor;
      totals.set(section, current);
    }
    return [...totals.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [uniqueLines]);

  const projection = shadow?.projection ?? null;
  const totalExposure = projection
    ? projection.totalOutflowMinor + projection.unknownTimingMinor + projection.outsideHorizonMinor
    : 0;
  const selectedPeriod = projection?.periods[selectedIndex] ?? null;

  async function recalculate() {
    setPreviewing(true);
    setError(null);
    try {
      await calculatePreview(finance, timingOverrides);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not calculate preview");
    } finally {
      setPreviewing(false);
    }
  }

  async function checkReadiness() {
    setCheckingReadiness(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/finance/readiness`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_date: effectiveDate,
          contract_evidence: {
            reference: contractReference.trim(),
            signed_at: contractSignedAt,
          },
        }),
      });
      const body = (await response.json()) as { readiness?: FinanceActivationReadiness } & ApiError;
      if (!response.ok) throw new Error(body.error ?? "Could not check activation readiness");
      setReadiness(body.readiness ?? null);
    } catch (readinessError) {
      setError(readinessError instanceof Error ? readinessError.message : "Could not check readiness");
    } finally {
      setCheckingReadiness(false);
    }
  }

  async function activate() {
    if (
      !readiness?.ready ||
      !readiness.estimate_version_id ||
      !readiness.policy_version_id ||
      !readiness.program_watermark ||
      !activationReason.trim()
    ) {
      return;
    }
    setActivating(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/finance/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_date: effectiveDate,
          estimate_version_id: readiness.estimate_version_id,
          policy_version_id: readiness.policy_version_id,
          contract_evidence: {
            reference: contractReference.trim(),
            signed_at: contractSignedAt,
          },
          reason: activationReason.trim(),
          idempotency_key: crypto.randomUUID(),
          expected_profile_version: readiness.profile_version,
          program_watermark: readiness.program_watermark,
        }),
      });
      const body = (await response.json()) as ApiError;
      if (!response.ok) {
        if (body.readiness) setReadiness(body.readiness);
        throw new Error(body.error ?? "Could not activate project finance");
      }
      setSuccess("Project finance activated. The immutable baseline now forms part of the company base.");
      setReadiness(null);
      await loadWorkspace();
      setActiveTab("position");
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : "Could not activate finance");
    } finally {
      setActivating(false);
    }
  }

  if (loading && !finance) {
    return <div className="h-72 animate-pulse border border-charcoal/15 bg-offwhite" aria-label="Loading project finance" />;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="border border-red-700/35 bg-red-50 p-4 text-body text-red-800">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="border border-[#4c6b4f]/40 bg-[#4c6b4f]/5 p-4 text-body text-[#304b33]">
          {success}
        </div>
      )}

      {finance && (
        <section className="border border-charcoal/20 bg-offwhite">
          <div className="flex flex-col gap-5 border-b border-charcoal/20 p-5 md:flex-row md:items-start md:justify-between md:p-7">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <FinanceStatePill state={finance.finance.finance_state} />
                <span className="border border-charcoal/20 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-charcoal/60">
                  Shadow calculation
                </span>
              </div>
              <h1 className="mt-4 font-display text-[38px] font-light leading-none text-nearblack md:text-[46px]">
                Cost and cash together
              </h1>
              <p className="mt-3 text-body text-charcoal/60">
                {finance.project.job_number ?? "No job number"} · {shadow?.source.estimate_label ?? "No estimate source"}
              </p>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void recalculate();
              }}
              className="grid w-full gap-3 border border-charcoal/15 bg-cream p-4 sm:grid-cols-[1fr_1fr_auto] md:max-w-2xl"
            >
              <label>
                <span className="label-caps">As of</span>
                <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" />
              </label>
              <label>
                <span className="label-caps">Opening cash preview</span>
                <input inputMode="decimal" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} placeholder="0" className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body" />
              </label>
              <button type="submit" disabled={previewing} className="self-end bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-40">
                {previewing ? "Calculating…" : "Recalculate"}
              </button>
            </form>
          </div>
          <div className="flex overflow-x-auto px-4 md:px-7" role="tablist" aria-label="Project finance views">
            {[
              ["position", "Position"],
              ["timing", `Forecast timing${projection?.unknownTimingMinor ? " · needs review" : ""}`],
              ["activation", finance.finance.finance_state === "active" ? "Activation record" : "Activate finance"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setActiveTab(key as WorkspaceTab)}
                className={`shrink-0 border-b-2 px-4 py-3 text-subhead ${activeTab === key ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/50 hover:text-nearblack"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      )}

      {finance && activeTab === "activation" ? (
        <section className="grid gap-5 lg:grid-cols-2" aria-labelledby="activation-heading">
          <div className="border border-charcoal/20 bg-offwhite p-5 md:p-7">
            <p className="label-caps">Committed base</p>
            <h2 id="activation-heading" className="mt-2 font-display text-section text-nearblack">
              {finance.finance.finance_state === "active" ? "Activation record" : "Explicit activation act"}
            </h2>
            {finance.finance.finance_state === "active" ? (
              <dl className="mt-6 space-y-4 text-body">
                <div className="border-b border-charcoal/10 pb-3"><dt className="label-caps">Activated</dt><dd className="mt-1">{finance.finance.activated_at ? new Intl.DateTimeFormat("en-AU", { dateStyle: "long", timeStyle: "short" }).format(new Date(finance.finance.activated_at)) : "Not recorded"}</dd></div>
                <div className="border-b border-charcoal/10 pb-3"><dt className="label-caps">Baseline</dt><dd className="mt-1 break-all">{finance.finance.active_baseline?.id ?? finance.finance.active_baseline_id}</dd></div>
                <div className="border-b border-charcoal/10 pb-3"><dt className="label-caps">Effective date</dt><dd className="mt-1">{formatFinanceDate(finance.finance.active_baseline?.effective_date)}</dd></div>
                <div><dt className="label-caps">Program watermark</dt><dd className="mt-1 break-all text-caption">{finance.finance.active_baseline?.program_watermark ?? "Not available"}</dd></div>
              </dl>
            ) : (
              <div className="mt-6 space-y-4">
                <label className="block"><span className="label-caps">Effective date</span><input type="date" value={effectiveDate} onChange={(event) => { setEffectiveDate(event.target.value); setReadiness(null); }} className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" /></label>
                <label className="block"><span className="label-caps">Signed contract reference</span><input value={contractReference} onChange={(event) => { setContractReference(event.target.value); setReadiness(null); }} placeholder="Contract file, signing envelope or reference" className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" /></label>
                <label className="block"><span className="label-caps">Contract signed date</span><input type="date" value={contractSignedAt} onChange={(event) => { setContractSignedAt(event.target.value); setReadiness(null); }} className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" /></label>
                <button type="button" onClick={() => void checkReadiness()} disabled={checkingReadiness} className="w-full border border-nearblack px-4 py-3 text-subhead text-nearblack hover:bg-cream disabled:opacity-40">
                  {checkingReadiness ? "Checking…" : "Check readiness"}
                </button>
              </div>
            )}
          </div>

          <div className="border border-charcoal/20 bg-nearblack p-5 text-white md:p-7">
            <p className="label-caps text-sand">First 13-week effect</p>
            <p className="mt-3 font-display text-[34px] leading-none">-{formatMinorCurrency(projection?.totalOutflowMinor ?? 0)}</p>
            <p className="mt-2 text-body text-white/55">{formatMinorCurrency(projection?.unknownTimingMinor ?? 0)} remains outside weekly cash until timing is approved.</p>

            {finance.finance.finance_state !== "active" && (
              <>
                <div className="mt-6 space-y-2">
                  {(readiness?.checks ?? [
                    { code: "signed_contract" as const, ready: false, message: "Check readiness to validate current evidence." },
                    { code: "saved_estimate" as const, ready: false, message: "Check readiness to validate current evidence." },
                    { code: "dated_program" as const, ready: false, message: "Check readiness to validate current evidence." },
                    { code: "published_policy" as const, ready: false, message: "Check readiness to validate current evidence." },
                    { code: "lifecycle_state" as const, ready: false, message: "Check readiness to validate current evidence." },
                  ]).map((check) => (
                    <div key={check.code} className="flex items-start gap-3 border border-white/15 p-3 text-body">
                      <span aria-hidden className={check.ready ? "text-[#91b294]" : "text-sand"}>{check.ready ? "✓" : "○"}</span>
                      <span><span className="block text-white">{checkLabel(check.code)}</span><span className="mt-1 block text-caption text-white/45">{check.message}</span></span>
                    </div>
                  ))}
                </div>
                <label className="mt-5 block"><span className="label-caps text-sand">Activation reason</span><textarea value={activationReason} onChange={(event) => setActivationReason(event.target.value)} rows={3} placeholder="Why this project should enter the committed company base" className="mt-2 w-full border border-white/25 bg-charcoal px-3 py-2 text-body text-white placeholder:text-white/35" /></label>
                <button type="button" onClick={() => void activate()} disabled={!readiness?.ready || !activationReason.trim() || activating} className="mt-4 w-full bg-sand px-4 py-3 text-subhead text-nearblack hover:bg-[#b09a7c] disabled:cursor-not-allowed disabled:opacity-35">
                  {activating ? "Activating atomically…" : "Activate and publish baseline"}
                </button>
                <p className="mt-3 text-caption text-white/45">This adds construction commitments to the company base. Failure creates no partial finance records.</p>
              </>
            )}
          </div>
        </section>
      ) : activeTab === "timing" ? (
        <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="timing-heading">
          <div className="flex flex-col gap-3 border-b border-charcoal/20 p-5 md:flex-row md:items-end md:justify-between md:p-7">
            <div><p className="label-caps">Explicit timing</p><h2 id="timing-heading" className="mt-2 font-display text-section text-nearblack">Place forecast lines in time</h2><p className="mt-2 max-w-2xl text-body text-charcoal/55">These dates are shadow-only in this milestone. They recalculate the preview but do not alter the immutable estimate or baseline.</p></div>
            <button type="button" onClick={() => void recalculate()} disabled={previewing} className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-40">{previewing ? "Calculating…" : "Recalculate preview"}</button>
          </div>
          <div className="divide-y divide-charcoal/10">
            {uniqueLines.map((line) => (
              <div key={line.contributionKey} className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_150px_160px] md:items-center md:px-6">
                <div><p className="text-body text-nearblack">{line.description}</p><p className="mt-1 text-caption text-charcoal/45">{String(line.sourceTrace.section_name ?? line.sourceTrace.category ?? "Other")} · {line.confidence} confidence</p></div>
                <p className="text-subhead md:text-right">{formatMinorCurrency(line.amountMinor)}</p>
                <label><span className="sr-only">Forecast date for {line.description}</span><input type="date" value={timingOverrides[line.contributionKey] ?? line.effectiveDate ?? ""} onChange={(event) => setTimingOverrides((current) => { const next = { ...current }; if (event.target.value) next[line.contributionKey] = event.target.value; else delete next[line.contributionKey]; return next; })} className="w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" /></label>
              </div>
            ))}
            {uniqueLines.length === 0 && <p className="p-8 text-center text-body text-charcoal/50">No estimate forecast lines are available.</p>}
          </div>
        </section>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Cost exposure", formatMinorCurrency(totalExposure), `${uniqueLines.length} forecast lines`],
              ["13-week outflow", formatMinorCurrency(projection?.totalOutflowMinor ?? 0), `${formatMinorCurrency(projection?.outsideHorizonMinor ?? 0)} after horizon`],
              ["Timing unknown", formatMinorCurrency(projection?.unknownTimingMinor ?? 0), projection?.unknownTimingMinor ? "Review required before relying on weekly cash" : "All effective amounts have timing"],
              ["13-week impact", formatMinorCurrency((projection?.periods.at(-1)?.closingCashMinor ?? 0) - (projection?.openingCashMinor ?? 0)), shadow?.committed_base_eligible ? "Included in company base" : "Candidate · excluded from company base"],
            ].map(([label, value, detail]) => (
              <div key={label} className="border border-charcoal/20 bg-offwhite p-5"><p className="label-caps">{label}</p><p className="mt-3 font-display text-[30px] leading-none text-nearblack">{value}</p><p className="mt-3 text-caption text-charcoal/50">{detail}</p></div>
            ))}
          </div>
          {projection && <section className="border border-charcoal/20 bg-offwhite"><div className="border-b border-charcoal/20 p-5 md:p-7"><p className="label-caps">Project cash impact</p><h2 className="mt-2 font-display text-section text-nearblack">13-week movement</h2></div><div className="p-4 md:p-7"><FinanceCashCurve periods={projection.periods} selectedIndex={selectedIndex} onSelect={setSelectedIndex} /></div>{selectedPeriod && <div className="grid grid-cols-2 border-t border-charcoal/20 md:grid-cols-4">{[["Opening",selectedPeriod.openingCashMinor],["Inflows",selectedPeriod.inflowMinor],["Outflows",-selectedPeriod.outflowMinor],["Closing",selectedPeriod.closingCashMinor]].map(([label,value])=><div key={String(label)} className="border-r border-charcoal/15 p-4 last:border-r-0"><p className="label-caps">{String(label)}</p><p className="mt-2 text-subhead">{formatMinorCurrency(Number(value))}</p></div>)}</div>}</section>}
          <section className="border border-charcoal/20 bg-offwhite"><div className="border-b border-charcoal/20 p-5 md:p-7"><p className="label-caps">Cost position</p><h2 className="mt-2 font-display text-section text-nearblack">By estimate section</h2></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left"><thead className="bg-nearblack text-[7px] uppercase tracking-[0.14em] text-white"><tr><th className="px-5 py-3">Section</th><th className="px-5 py-3 text-right">Exposure</th><th className="px-5 py-3 text-right">Unknown</th><th className="px-5 py-3 text-right">Lines</th></tr></thead><tbody className="divide-y divide-charcoal/10">{sectionTotals.map(([section,total])=><tr key={section} className="text-body"><td className="px-5 py-4">{section}</td><td className="px-5 py-4 text-right">{formatMinorCurrency(total.amount)}</td><td className="px-5 py-4 text-right text-[#76570a]">{formatMinorCurrency(total.unknown)}</td><td className="px-5 py-4 text-right">{total.count}</td></tr>)}</tbody></table></div></section>
        </>
      )}
    </div>
  );
}
