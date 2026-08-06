"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FinanceCashCurve } from "./FinanceCashCurve";
import { FinancePolicyPanel } from "./FinancePolicyPanel";
import { FinanceRecurringCommitmentsPanel } from "./FinanceRecurringCommitmentsPanel";
import { FinanceStatePill } from "./FinanceStatePill";
import {
  adelaideToday,
  dollarsInputToMinor,
  formatFinanceDate,
  formatMinorCurrency,
} from "@/lib/finance/presentation";
import type { FinanceCockpitResponse, FinanceProjectionPeriod } from "@/types/finance";

type CockpitTab = "cash" | "commitments" | "projects" | "governance";

function MetricCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "attention" | "positive";
}) {
  return (
    <div className="border border-charcoal/20 bg-offwhite p-4 md:p-5">
      <p className="label-caps">{label}</p>
      <p
        className={`mt-3 font-display text-[30px] leading-none ${
          tone === "attention"
            ? "text-red-800"
            : tone === "positive"
              ? "text-[#304b33]"
              : "text-nearblack"
        }`}
      >
        {value}
      </p>
      <p className="mt-3 text-caption text-charcoal/55">{detail}</p>
    </div>
  );
}

function PeriodDetail({ period }: { period: FinanceProjectionPeriod }) {
  const inflows = period.contributions.filter((item) => item.direction === "inflow");
  const outflows = period.contributions.filter((item) => item.direction === "outflow");
  return (
    <section aria-labelledby="selected-week-heading" className="mt-5 border border-charcoal/20 bg-offwhite">
      <div className="grid grid-cols-2 border-b border-charcoal/20 md:grid-cols-4">
        {[
          ["Opening", period.openingCashMinor],
          ["Inflows", period.inflowMinor],
          ["Outflows", -period.outflowMinor],
          ["Closing", period.closingCashMinor],
        ].map(([label, value]) => (
          <div key={String(label)} className="border-b border-r border-charcoal/15 p-4 last:border-r-0 md:border-b-0">
            <p className="label-caps">{String(label)}</p>
            <p className="mt-2 text-subhead text-nearblack">{formatMinorCurrency(Number(value))}</p>
          </div>
        ))}
      </div>
      <div className="p-5 md:p-6">
        <p className="label-caps">Selected period</p>
        <h2 id="selected-week-heading" className="mt-2 font-display text-section text-nearblack">
          Week of {formatFinanceDate(period.startsOn)}
        </h2>
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          {[
            ["Inflows", inflows, "No dated inflows in this week."],
            ["Outflows", outflows, "No dated outflows in this week."],
          ].map(([heading, contributions, empty]) => (
            <div key={String(heading)} className="border border-charcoal/15 bg-cream p-4">
              <p className="label-caps">{String(heading)}</p>
              {(contributions as typeof period.contributions).length === 0 ? (
                <p className="mt-3 text-body text-charcoal/50">{String(empty)}</p>
              ) : (
                <ul className="mt-3 divide-y divide-charcoal/10">
                  {(contributions as typeof period.contributions).map((item) => (
                    <li key={`${item.contributionKey}:${item.state}`} className="flex items-start justify-between gap-4 py-3 text-body">
                      <span>
                        <span className="block text-nearblack">{item.description}</span>
                        <span className="mt-1 block text-caption text-charcoal/50">
                          {String(item.sourceTrace.project_name ?? item.sourceTrace.supplier_or_payee ?? item.sourceTrace.category ?? item.state)} · {item.confidence} confidence
                        </span>
                      </span>
                      <span className="shrink-0 text-nearblack">{formatMinorCurrency(item.amountMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinanceCockpit() {
  const [data, setData] = useState<FinanceCockpitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState(adelaideToday);
  const [openingCash, setOpeningCash] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<CockpitTab>("cash");

  const loadCockpit = useCallback(async () => {
    const openingMinor = dollarsInputToMinor(openingCash);
    if (openingCash.trim() && openingMinor === null) {
      setError("Opening cash must be a dollar amount with no more than two decimal places.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ as_of_date: asOfDate });
      if (openingMinor !== null) query.set("opening_cash_minor", String(openingMinor));
      const response = await fetch(`/api/finance/cockpit?${query.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as FinanceCockpitResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load finance cockpit");
      setData(body);
      setSelectedIndex((current) =>
        body.projection && current < body.projection.periods.length ? current : 0
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load finance cockpit");
    } finally {
      setLoading(false);
    }
  }, [asOfDate, openingCash]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCockpit(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Deliberately load once; edited preview inputs apply only on Refresh.

  const sortedProjects = useMemo(() => {
    if (!data) return [];
    const order = { active: 0, ready: 1, candidate: 2, design_only: 3, suspended: 4, closed: 5, cancelled: 6 };
    return [...data.projects].sort(
      (a, b) => order[a.finance_state] - order[b.finance_state] || b.exposure_minor - a.exposure_minor
    );
  }, [data]);
  const projection = data?.projection ?? null;
  const selectedPeriod = projection?.periods[selectedIndex] ?? null;
  const lowestPeriod =
    projection?.lowestCashPeriodIndex === null || projection?.lowestCashPeriodIndex === undefined
      ? null
      : projection.periods[projection.lowestCashPeriodIndex];
  const exceptionCount = data
    ? data.projects.filter((project) => project.unknown_timing_minor > 0).length +
      (data.source_status.xero === "healthy" ? 0 : 1)
    : 0;

  return (
    <div className="space-y-6">
      <section className="border border-charcoal/20 bg-offwhite">
        <div className="flex flex-col gap-5 border-b border-charcoal/20 p-5 md:flex-row md:items-start md:justify-between md:p-7">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-nearblack px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-white">
                Shadow base
              </span>
              <span className="border border-[#c9971e] bg-[#c9971e]/10 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em] text-[#76570a]">
                Xero not connected
              </span>
            </div>
            <h1 className="mt-4 font-display text-[38px] font-light leading-none text-nearblack md:text-[46px]">
              Executive finance cockpit
            </h1>
            <p className="mt-3 max-w-2xl text-body text-charcoal/60">
              Active construction commitments only. This preview is deterministic, never persisted,
              and keeps unknown timing visible instead of treating it as zero.
            </p>
          </div>
          <form
            className="grid w-full gap-3 border border-charcoal/15 bg-cream p-4 sm:grid-cols-[1fr_1fr_auto] md:max-w-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              void loadCockpit();
            }}
          >
            <label>
              <span className="label-caps">As of</span>
              <input
                type="date"
                value={asOfDate}
                onChange={(event) => setAsOfDate(event.target.value)}
                className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"
              />
            </label>
            <label>
              <span className="label-caps">Opening cash preview</span>
              <input
                inputMode="decimal"
                value={openingCash}
                onChange={(event) => setOpeningCash(event.target.value)}
                placeholder="Not configured"
                className="mt-2 w-full border border-charcoal/20 bg-offwhite px-3 py-2 text-body"
              />
            </label>
            <button
              type="submit"
              disabled={loading}
              className="self-end bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-40"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </form>
        </div>

        <div className="flex overflow-x-auto border-b border-charcoal/20 px-4 md:px-7" role="tablist" aria-label="Finance cockpit views">
          {[
            ["cash", "Cash timeline"],
            ["commitments", "Recurring commitments"],
            ["projects", "Projects"],
            ...(data?.can_manage_policy ? [["governance", "Governance"]] : []),
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              onClick={() => setActiveTab(key as CockpitTab)}
              className={`shrink-0 border-b-2 px-4 py-3 text-subhead ${
                activeTab === key
                  ? "border-nearblack text-nearblack"
                  : "border-transparent text-charcoal/50 hover:text-nearblack"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div role="alert" className="border border-red-700/35 bg-red-50 p-4 text-body text-red-800">
          <p className="font-medium">Finance cockpit unavailable</p>
          <p className="mt-1">{error}</p>
        </div>
      )}

      {loading && !data ? (
        <div aria-live="polite" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-32 animate-pulse border border-charcoal/10 bg-offwhite" />
          ))}
        </div>
      ) : activeTab === "governance" && data?.can_manage_policy ? (
        <FinancePolicyPanel />
      ) : activeTab === "commitments" && data ? (
        <FinanceRecurringCommitmentsPanel
          asOfDate={asOfDate}
          canEdit={data.can_edit_forecast}
          onChanged={() => void loadCockpit()}
        />
      ) : activeTab === "projects" ? (
        <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="finance-projects-heading">
          <div className="border-b border-charcoal/20 p-5 md:p-7">
            <p className="label-caps">Portfolio scope</p>
            <h2 id="finance-projects-heading" className="mt-2 font-display text-section text-nearblack">
              Project finance lifecycle
            </h2>
            <p className="mt-2 text-body text-charcoal/60">
              Only active projects enter the committed company base. Candidates remain explicitly excluded.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="bg-nearblack text-white">
                <tr className="text-[7px] uppercase tracking-[0.14em]">
                  <th className="px-5 py-3">Project</th>
                  <th className="px-5 py-3">State</th>
                  <th className="px-5 py-3 text-right">Exposure</th>
                  <th className="px-5 py-3 text-right">Unknown timing</th>
                  <th className="px-5 py-3 text-right">Lines</th>
                  <th className="px-5 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10">
                {sortedProjects.map((project) => (
                  <tr key={project.project_id} className="text-body hover:bg-cream">
                    <td className="px-5 py-4">
                      <span className="block text-nearblack">{project.name}</span>
                      <span className="mt-1 block text-caption text-charcoal/45">
                        {project.job_number ?? "No job number"}
                      </span>
                    </td>
                    <td className="px-5 py-4"><FinanceStatePill state={project.finance_state} /></td>
                    <td className="px-5 py-4 text-right">{formatMinorCurrency(project.exposure_minor)}</td>
                    <td className="px-5 py-4 text-right text-[#76570a]">{formatMinorCurrency(project.unknown_timing_minor)}</td>
                    <td className="px-5 py-4 text-right">{project.forecast_line_count}</td>
                    <td className="px-5 py-4 text-right">
                      <Link href={`/projects/${project.project_id}/finance`} className="border-b border-charcoal/30 text-caption text-nearblack hover:border-nearblack">
                        Open finance
                      </Link>
                    </td>
                  </tr>
                ))}
                {sortedProjects.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-12 text-center text-body text-charcoal/50">No permitted finance projects.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Available cash"
              value={projection ? formatMinorCurrency(projection.openingCashMinor) : "—"}
              detail={data?.source_status.opening_cash === "request_preview" ? "Manual preview · not persisted" : "Connect approved bank source or enter preview"}
            />
            <MetricCard
              label="13-week low"
              value={projection ? formatMinorCurrency(projection.lowestCashMinor) : "—"}
              detail={lowestPeriod ? `Week of ${formatFinanceDate(lowestPeriod.startsOn)}` : "No movement below opening cash"}
              tone={projection && projection.lowestCashMinor < 0 ? "attention" : "default"}
            />
            <MetricCard
              label="Dated outflows"
              value={projection ? formatMinorCurrency(projection.totalOutflowMinor) : "—"}
              detail={`${data?.counts.active_projects ?? 0} active project${data?.counts.active_projects === 1 ? "" : "s"} · ${data?.counts.connected_client_claims ?? 0} client claims · ${data?.counts.active_recurring_commitments ?? 0} recurring costs`}
            />
            <MetricCard
              label="Exceptions"
              value={String(exceptionCount)}
              detail={projection ? `${formatMinorCurrency(projection.unknownTimingMinor)} timing unknown` : "Shadow calculation switch is off"}
              tone={exceptionCount > 0 ? "attention" : "positive"}
            />
          </div>

          <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="cash-curve-heading">
            <div className="flex flex-col gap-3 border-b border-charcoal/20 p-5 md:flex-row md:items-end md:justify-between md:p-7">
              <div>
                <p className="label-caps">Cash curve</p>
                <h2 id="cash-curve-heading" className="mt-2 font-display text-section text-nearblack">Actual and base forecast</h2>
              </div>
              <p className="text-caption text-charcoal/50">
                Calculated {data ? new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.source_status.calculated_at)) : "—"}
              </p>
            </div>
            {projection ? (
              <div className="p-4 md:p-7">
                <FinanceCashCurve periods={projection.periods} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
              </div>
            ) : (
              <div className="p-10 text-center">
                <p className="text-subhead text-nearblack">Shadow projection is disabled.</p>
                <p className="mt-2 text-body text-charcoal/55">Enable the server-side shadow flag only after migration and permission checks pass.</p>
              </div>
            )}
          </section>

          {selectedPeriod && <PeriodDetail period={selectedPeriod} />}

          <section className="grid gap-4 md:grid-cols-3">
            <div className="border border-[#c9971e]/40 bg-[#c9971e]/5 p-5">
              <p className="label-caps">Coverage</p>
              <p className="mt-3 text-subhead text-nearblack">
                {projection ? formatMinorCurrency(projection.unknownTimingMinor) : "—"} unallocated
              </p>
              <p className="mt-2 text-body text-charcoal/55">Unknown amounts remain outside weekly cash until an explicit date is approved.</p>
            </div>
            <div className="border border-charcoal/20 bg-offwhite p-5">
              <p className="label-caps">Xero actuals</p>
              <p className="mt-3 text-subhead text-nearblack">Not connected</p>
              <p className="mt-2 text-body text-charcoal/55">Opening cash, posted bills and bank freshness are not represented yet.</p>
            </div>
            <div className="border border-charcoal/20 bg-offwhite p-5">
              <p className="label-caps">Base integrity</p>
              <p className="mt-3 text-subhead text-nearblack">{data?.counts.active_projects ?? 0} activated</p>
              <p className="mt-2 text-body text-charcoal/55">{data?.counts.candidate_projects ?? 0} candidate and {data?.counts.design_only_projects ?? 0} design-only projects are excluded.</p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
