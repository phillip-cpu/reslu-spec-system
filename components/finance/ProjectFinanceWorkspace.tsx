"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FinanceCashCurve } from "./FinanceCashCurve";
import {
  adelaideToday,
  dollarsInputToMinor,
  formatFinanceDate,
  formatMinorCurrency,
} from "@/lib/finance/presentation";
import type {
  FinanceShadowProjectionResponse,
  ProjectCommercialProfile,
  ProjectFinanceResponse,
} from "@/types/finance";
import { projectStageLabel } from "@/lib/project-lifecycle";

type WorkspaceTab = "position" | "setup";

type ApiError = { error?: string };

function CommercialSetup({
  projectId,
  profile,
  onSaved,
  onError,
}: {
  projectId: string;
  profile: ProjectCommercialProfile;
  onSaved: (profile: ProjectFinanceResponse) => void;
  onError: (message: string | null) => void;
}) {
  const projectStage = profile.project_stage;
  const [contractType, setContractType] = useState(profile.contract_type);
  const [contractLabel, setContractLabel] = useState(profile.contract_label);
  const [contractAmount, setContractAmount] = useState(String(profile.contract_amount_inc_gst || ""));
  const [contractReference, setContractReference] = useState(profile.contract_reference ?? "");
  const [signed, setSigned] = useState(Boolean(profile.contract_signed_at));
  const [contractSignedAt, setContractSignedAt] = useState(profile.contract_signed_at ?? "");
  const [dueDays, setDueDays] = useState(String(profile.due_days));
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const amount = Number(contractAmount);
    if (!contractLabel.trim() || !Number.isFinite(amount) || amount < 0) {
      onError("Enter a contract name and valid amount.");
      return;
    }
    if (signed && (!contractReference.trim() || !contractSignedAt)) {
      onError("A signed contract needs its agreement reference and signed date.");
      return;
    }
    setSaving(true);
    onError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/commercial`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_stage: projectStage,
          contract_type: contractType,
          contract_label: contractLabel.trim(),
          contract_amount_inc_gst: amount,
          contract_reference: signed ? contractReference.trim() : null,
          contract_signed_at: signed ? contractSignedAt : null,
          due_days: Number(dueDays),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save commercial setup");
      const refreshed = await fetch(`/api/projects/${projectId}/finance`, { cache: "no-store" });
      const refreshedBody = (await refreshed.json()) as ProjectFinanceResponse & ApiError;
      if (!refreshed.ok) throw new Error(refreshedBody.error ?? "Could not refresh project finance");
      onSaved(refreshedBody);
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : "Could not save commercial setup");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="commercial-heading">
      <div className="border-b border-charcoal/20 p-5 md:p-7">
        <p className="label-caps">Project setup</p>
        <h2 id="commercial-heading" className="mt-2 font-display text-section text-nearblack">
          Stage and signed contract
        </h2>
        <p className="mt-2 max-w-2xl text-body text-charcoal/55">
          This is the project&apos;s commercial source of truth. Payment claims and cash forecasts use the same contract record.
        </p>
      </div>
      <form onSubmit={save} className="grid gap-5 p-5 md:grid-cols-2 md:p-7 xl:grid-cols-3">
        <div>
          <span className="label-caps">Job stage</span>
          <div className="mt-2 border border-charcoal/20 bg-cream px-3 py-2 text-body text-charcoal/70">
            {projectStageLabel(projectStage)}
          </div>
          <p className="mt-1 text-caption text-charcoal/45">Managed in the Job lifecycle bar above.</p>
        </div>
        <label>
          <span className="label-caps">Contract type</span>
          <select value={contractType} onChange={(event) => setContractType(event.target.value as ProjectCommercialProfile["contract_type"])} className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body">
            <option value="design">Design</option>
            <option value="construction">Construction</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          <span className="label-caps">Contract name</span>
          <input value={contractLabel} onChange={(event) => setContractLabel(event.target.value)} placeholder="Construction contract" className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" />
        </label>
        <label>
          <span className="label-caps">Original contract inc GST</span>
          <input type="number" min="0" step="0.01" value={contractAmount} onChange={(event) => setContractAmount(event.target.value)} placeholder="150000" className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" />
        </label>
        <label>
          <span className="label-caps">Agreement status</span>
          <select value={signed ? "signed" : "not_signed"} onChange={(event) => { const nextSigned = event.target.value === "signed"; setSigned(nextSigned); if (nextSigned && !contractSignedAt) setContractSignedAt(adelaideToday()); }} className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body">
            <option value="not_signed">Not signed</option>
            <option value="signed">Signed</option>
          </select>
        </label>
        <label>
          <span className="label-caps">Payment terms (days)</span>
          <input type="number" min="0" value={dueDays} onChange={(event) => setDueDays(event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" />
        </label>
        {signed && (
          <>
            <label className="md:col-span-1 xl:col-span-2">
              <span className="label-caps">Agreement reference</span>
              <input value={contractReference} onChange={(event) => setContractReference(event.target.value)} placeholder="e.g. Goldsworthy construction contract" className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" />
            </label>
            <label>
              <span className="label-caps">Signed date</span>
              <input type="date" value={contractSignedAt} onChange={(event) => setContractSignedAt(event.target.value)} className="mt-2 w-full border border-charcoal/20 bg-cream px-3 py-2 text-body" />
            </label>
          </>
        )}
        <div className="md:col-span-2 xl:col-span-3">
          <button type="submit" disabled={saving} className="bg-nearblack px-5 py-2.5 text-subhead text-white hover:bg-charcoal disabled:opacity-40">
            {saving ? "Saving…" : "Save project setup"}
          </button>
        </div>
      </form>
    </section>
  );
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
  const [previewing, setPreviewing] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const loadFinance = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/finance`, { cache: "no-store" });
    const body = (await response.json()) as ProjectFinanceResponse & ApiError;
    if (!response.ok) throw new Error(body.error ?? "Could not load project finance");
    setFinance(body);
    return body;
  }, [projectId]);

  const calculatePreview = useCallback(
    async (profile: ProjectFinanceResponse | null) => {
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
      await calculatePreview(profile);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load project finance");
    } finally {
      setLoading(false);
    }
  }, [calculatePreview, loadFinance]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Initial snapshot; Timeline links and dates are read from the server.

  const sectionTotals = useMemo(() => {
    const totals = new Map<string, { amount: number; keys: Set<string>; unknown: number }>();
    for (const line of shadow?.projection.effectiveContributions ?? []) {
      if (line.direction !== "outflow") continue;
      const section = String(line.sourceTrace.section_name ?? line.sourceTrace.category ?? "Other");
      const current = totals.get(section) ?? { amount: 0, keys: new Set<string>(), unknown: 0 };
      current.amount += line.amountMinor;
      current.keys.add(line.contributionKey);
      if (!line.effectiveDate) current.unknown += line.amountMinor;
      totals.set(section, current);
    }
    return [...totals.entries()]
      .map(([section, total]) => [section, {
        amount: total.amount,
        count: total.keys.size,
        unknown: total.unknown,
      }] as const)
      .sort((a, b) => b[1].amount - a[1].amount);
  }, [shadow]);

  const projection = shadow?.projection ?? null;
  const totalExposure = projection
    ? projection.effectiveContributions
        .filter((contribution) => contribution.direction === "outflow")
        .reduce((sum, contribution) => sum + contribution.amountMinor, 0)
    : 0;
  const unknownOutflow = projection
    ? projection.effectiveContributions
        .filter(
          (contribution) =>
            contribution.direction === "outflow" && !contribution.effectiveDate
        )
        .reduce((sum, contribution) => sum + contribution.amountMinor, 0)
    : 0;
  const selectedPeriod = projection?.periods[selectedIndex] ?? null;
  const clientClaimContributions = projection?.effectiveContributions.filter(
    (contribution) => contribution.sourceTrace.source_type === "client_claim"
  ) ?? [];
  const clientPaid = clientClaimContributions
    .filter((contribution) => contribution.state === "actual_paid")
    .reduce((sum, contribution) => sum + contribution.amountMinor, 0);
  const clientRemaining = clientClaimContributions
    .filter((contribution) => contribution.state !== "actual_paid")
    .reduce((sum, contribution) => sum + contribution.amountMinor, 0);
  const constructionCostsIncluded = shadow?.source.construction_costs_included !== false;
  const readinessItems = useMemo(() => {
    const source = shadow?.source;
    if (!source) return [];

    const costSectionCount = source.cost_section_count ?? 0;
    const scheduleLinkCount = source.schedule_link_count ?? 0;
    const directItemCount = source.ffe_direct_item_count ?? 0;
    const timedItemCount = source.ffe_timing_link_count ?? 0;
    const quotedItemCount = source.ffe_quoted_item_count ?? 0;
    const placeholderItemCount = source.ffe_placeholder_item_count ?? 0;
    const unpricedItemCount = source.ffe_unpriced_item_count ?? 0;
    const snapshotItemCount = source.estimate_ffe_direct_item_count ?? 0;
    const phaseCount = source.schedule_phase_count ?? 0;
    const datedPhaseCount = source.schedule_dated_phase_count ?? 0;
    const latestScheduleDate = source.latest_schedule_date ?? null;
    const scheduleIsCurrent = Boolean(
      latestScheduleDate && latestScheduleDate >= asOfDate
    );
    const estimateReady = Boolean(source.estimate_version_id);
    const ffeSnapshotReady =
      directItemCount === 0 ||
      (source.estimate_has_item_level_ffe === true && snapshotItemCount === directItemCount);

    return [
      {
        key: "estimate",
        label: "Saved estimate",
        ready: estimateReady && ffeSnapshotReady,
        detail: !estimateReady
          ? "Save an estimate version so Finance has a frozen cost source."
          : directItemCount === 0
            ? `${source.estimate_label ?? "Saved version"} is available; there are no direct FF&E items to freeze.`
            : ffeSnapshotReady
              ? `${source.estimate_label ?? "Saved version"} includes all ${directItemCount} directly purchased FF&E items.`
              : `${source.estimate_label ?? "Saved version"} contains ${snapshotItemCount} of ${directItemCount} current direct FF&E items. Save a fresh version after pricing is reviewed.`,
        href: `/projects/${projectId}/estimate?view=versions`,
        action: estimateReady && ffeSnapshotReady ? "View version" : "Open versions",
      },
      {
        key: "pricing",
        label: "FF&E pricing",
        ready: unpricedItemCount === 0,
        detail: directItemCount === 0
          ? "There are no directly purchased FF&E items waiting for pricing."
          : unpricedItemCount === 0
            ? `${quotedItemCount} items use supplier/trade pricing${placeholderItemCount > 0 ? ` and ${placeholderItemCount} still use provisional retail pricing` : ""}.`
            : `${unpricedItemCount} of ${directItemCount} directly purchased items have no price. ${quotedItemCount} use supplier/trade pricing and ${placeholderItemCount} use provisional retail pricing.`,
        href: `/projects/${projectId}?tab=ffe&view=procurement`,
        action: "Review pricing",
      },
      {
        key: "sections",
        label: "Trade cost timing",
        ready: costSectionCount > 0 && scheduleLinkCount === costSectionCount,
        detail: costSectionCount > 0
          ? `${scheduleLinkCount} of ${costSectionCount} estimate sections have usable timing from a dated Timeline phase.`
          : "No estimate cost sections are available to schedule yet.",
        href: `/projects/${projectId}/timeline`,
        action: "Open Timeline",
      },
      {
        key: "ffe",
        label: "FF&E order timing",
        ready: directItemCount === 0 || timedItemCount === directItemCount,
        detail: directItemCount > 0
          ? `${timedItemCount} of ${directItemCount} directly purchased items have a forecast order date from lead time and trade context.`
          : "There are no directly purchased FF&E items waiting for order timing.",
        href: `/projects/${projectId}?tab=ffe&view=procurement`,
        action: "Open FF&E",
      },
      {
        key: "timeline",
        label: "Timeline dates",
        ready:
          phaseCount > 0 &&
          datedPhaseCount === phaseCount &&
          scheduleIsCurrent,
        detail: phaseCount === 0
          ? "Create the build phases before relying on forecast dates."
          : datedPhaseCount !== phaseCount
            ? `${datedPhaseCount} of ${phaseCount} phases have both a start and finish date.`
            : scheduleIsCurrent
              ? `All ${phaseCount} phases are dated through ${formatFinanceDate(latestScheduleDate)}.`
              : `All ${phaseCount} phases are dated, but the Timeline ends ${formatFinanceDate(latestScheduleDate)}—before this forecast's ${formatFinanceDate(asOfDate)} position.`,
        href: `/projects/${projectId}/timeline`,
        action: "Review dates",
      },
      {
        key: "gate",
        label: "Construction forecast",
        ready: constructionCostsIncluded,
        waiting: !constructionCostsIncluded,
        detail: constructionCostsIncluded
          ? "The job stage and construction contract setup allow build costs into cash flow."
          : "Build costs stay safely excluded while this is a Design/Quote job without active construction contract setup.",
        href: `/projects/${projectId}/finance`,
        action: constructionCostsIncluded ? "View setup" : "Review when signed",
      },
    ];
  }, [asOfDate, constructionCostsIncluded, projectId, shadow]);
  const readyCount = readinessItems.filter((item) => item.ready).length;

  async function recalculate() {
    setPreviewing(true);
    setError(null);
    try {
      await calculatePreview(finance);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not calculate preview");
    } finally {
      setPreviewing(false);
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
                <span className="border border-[#4c6b4f] bg-[#4c6b4f]/10 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-[#304b33]">
                  Finance connected
                </span>
                <span className="border border-sand/60 bg-sand/10 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-[#76570a]">
                  {projectStageLabel(finance.project.project_stage)}
                </span>
                <span className="border border-charcoal/20 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-charcoal/60">
                  Live forecast
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
              ["setup", "Project setup"],
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

      {finance && activeTab === "setup" ? (
        <CommercialSetup
          key={`${finance.project.project_stage}-${finance.commercial.contract_amount_inc_gst}-${finance.commercial.contract_signed_at ?? "unsigned"}`}
          projectId={projectId}
          profile={finance.commercial}
          onSaved={(updated) => {
            setFinance(updated);
            setSuccess("Project stage and contract details saved.");
          }}
          onError={setError}
        />
      ) : (
        <>
          <section className="flex flex-col gap-4 border border-sand/50 bg-sand/10 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="label-caps">{constructionCostsIncluded ? "Pulled from your existing project" : "Design-stage finance"}</p>
              <p className="mt-2 text-body text-charcoal/65">
                {constructionCostsIncluded
                  ? "Amounts stay frozen to the saved estimate. Trade costs follow their linked Timeline phase; FF&E follows each item's order-by date from its lead time and linked trade booking. Missing links remain visibly undated."
                  : "This position shows the design fee and its client payments only. The prospective build estimate is excluded until the project moves beyond Design/Quote with a construction contract."}
              </p>
              {constructionCostsIncluded && (shadow?.source.ffe_direct_item_count ?? 0) > 0 && (
                <p className="mt-2 text-caption text-charcoal/50">
                  FF&amp;E timing connected for {shadow?.source.ffe_timing_link_count ?? 0} of {shadow?.source.ffe_direct_item_count ?? 0} directly purchased items.
                </p>
              )}
            </div>
            <a href={`/projects/${projectId}/timeline`} className="shrink-0 border border-nearblack px-4 py-2 text-center text-subhead text-nearblack hover:bg-nearblack hover:text-white">
              Open Timeline
            </a>
          </section>
          {readinessItems.length > 0 && (
            <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="forecast-readiness-heading">
              <div className="flex flex-col gap-3 border-b border-charcoal/20 p-5 sm:flex-row sm:items-end sm:justify-between md:p-7">
                <div>
                  <p className="label-caps">Forecast readiness</p>
                  <h2 id="forecast-readiness-heading" className="mt-2 font-display text-section text-nearblack">
                    Make the future build forecast reliable
                  </h2>
                  <p className="mt-2 max-w-3xl text-body text-charcoal/55">
                    These checks prepare Estimate, FF&amp;E and Timeline to feed the same cash forecast. They do not add build costs while the job remains in Design.
                  </p>
                </div>
                <p className="shrink-0 text-subhead text-charcoal/60">
                  {readyCount} of {readinessItems.length} ready
                </p>
              </div>
              <ol className="divide-y divide-charcoal/10">
                {readinessItems.map((item) => (
                  <li key={item.key} className="grid gap-3 p-5 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-center md:px-7">
                    <div>
                      <span className={`inline-block border px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.13em] ${item.ready ? "border-[#4c6b4f]/45 bg-[#4c6b4f]/10 text-[#304b33]" : item.waiting ? "border-charcoal/20 bg-cream text-charcoal/55" : "border-sand/60 bg-sand/10 text-[#76570a]"}`}>
                        {item.ready ? "Ready" : item.waiting ? "Waiting" : "Needs setup"}
                      </span>
                      <p className="mt-2 text-subhead text-nearblack">{item.label}</p>
                    </div>
                    <p className="text-body text-charcoal/60">{item.detail}</p>
                    {item.key === "gate" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTab("setup");
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                        className="min-h-11 shrink-0 border border-charcoal/25 px-4 py-3 text-center text-caption text-nearblack hover:border-nearblack hover:bg-nearblack hover:text-white"
                      >
                        {item.action}
                      </button>
                    ) : (
                      <a href={item.href} className="min-h-11 shrink-0 border border-charcoal/25 px-4 py-3 text-center text-caption text-nearblack hover:border-nearblack hover:bg-nearblack hover:text-white">
                        {item.action}
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              [constructionCostsIncluded ? "Cost exposure" : "Build costs", constructionCostsIncluded ? formatMinorCurrency(totalExposure) : "Excluded", constructionCostsIncluded ? `${formatMinorCurrency(unknownOutflow)} cost timing unknown` : "Not charged against the design fee"],
              ["Client paid", formatMinorCurrency(clientPaid), "Confirmed client receipts"],
              ["Still to receive", formatMinorCurrency(clientRemaining), "Issued and future contract claims"],
              ["13-week impact", formatMinorCurrency((projection?.periods.at(-1)?.closingCashMinor ?? 0) - (projection?.openingCashMinor ?? 0)), "Flows automatically into company cashflow"],
            ].map(([label, value, detail]) => (
              <div key={label} className="border border-charcoal/20 bg-offwhite p-5"><p className="label-caps">{label}</p><p className="mt-3 font-display text-[30px] leading-none text-nearblack">{value}</p><p className="mt-3 text-caption text-charcoal/50">{detail}</p></div>
            ))}
          </div>
          {projection && <section className="border border-charcoal/20 bg-offwhite"><div className="border-b border-charcoal/20 p-5 md:p-7"><p className="label-caps">Project cash impact</p><h2 className="mt-2 font-display text-section text-nearblack">13-week movement</h2></div><div className="p-4 md:p-7"><FinanceCashCurve periods={projection.periods} selectedIndex={selectedIndex} onSelect={setSelectedIndex} /></div>{selectedPeriod && <div className="grid grid-cols-2 border-t border-charcoal/20 md:grid-cols-4">{[["Opening",selectedPeriod.openingCashMinor],["Inflows",selectedPeriod.inflowMinor],["Outflows",-selectedPeriod.outflowMinor],["Closing",selectedPeriod.closingCashMinor]].map(([label,value])=><div key={String(label)} className="border-r border-charcoal/15 p-4 last:border-r-0"><p className="label-caps">{String(label)}</p><p className="mt-2 text-subhead">{formatMinorCurrency(Number(value))}</p></div>)}</div>}</section>}
          {constructionCostsIncluded && <section className="border border-charcoal/20 bg-offwhite"><div className="border-b border-charcoal/20 p-5 md:p-7"><p className="label-caps">Cost position</p><h2 className="mt-2 font-display text-section text-nearblack">By estimate section and FF&amp;E category</h2></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left"><thead className="bg-nearblack text-[7px] uppercase tracking-[0.14em] text-white"><tr><th className="px-5 py-3">Section / category</th><th className="px-5 py-3 text-right">Exposure</th><th className="px-5 py-3 text-right">Unknown</th><th className="px-5 py-3 text-right">Lines</th></tr></thead><tbody className="divide-y divide-charcoal/10">{sectionTotals.map(([section,total])=><tr key={section} className="text-body"><td className="px-5 py-4">{section}</td><td className="px-5 py-4 text-right">{formatMinorCurrency(total.amount)}</td><td className="px-5 py-4 text-right text-[#76570a]">{formatMinorCurrency(total.unknown)}</td><td className="px-5 py-4 text-right">{total.count}</td></tr>)}</tbody></table></div></section>}
        </>
      )}
    </div>
  );
}
