"use client";

import { useEffect, useState, useCallback } from "react";
import {
  marketingPresetFrom,
  type MarketingSourceStatus,
  type OrganicOpportunity,
  type OrganicPagePerformance,
} from "@/lib/marketing";

// ── Types ──────────────────────────────────────────────────────────────────

interface DailyRow {
  date: string;
  google_spend: number;
  meta_spend: number;
  total_spend: number;
  conversions: number;
}

interface WeeklyRow {
  week: string;
  total_spend: number;
  google_spend: number;
  meta_spend: number;
  conversions: number;
}

interface SEOQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface MarketingData {
  from: string;
  to: string;
  summary: {
    total_spend: number;
    total_conversions: number;
    cost_per_lead: number | null;
    leads: number;
    google_spend: number;
    meta_spend: number;
    google_conversions: number;
    meta_conversions: number;
    google_ctr: number;
    meta_ctr: number;
  };
  sources: {
    google_ads: MarketingSourceStatus;
    meta_ads: MarketingSourceStatus;
    search_console: MarketingSourceStatus;
    leads: MarketingSourceStatus;
  };
  daily: DailyRow[];
  weekly: WeeklyRow[];
  seo: {
    top_queries: SEOQuery[];
    pages: OrganicPagePerformance[];
    top_pages: OrganicPagePerformance[];
    top_blogs: OrganicPagePerformance[];
    insights: OrganicOpportunity[];
    comparison: { from: string; to: string };
    totals: { clicks: number; impressions: number; ctr: number; avg_position: number };
  } | null;
}

interface MarketingDashboardProps {
  initialFrom: string;
  initialTo: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
function fmtPct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}
function shortDate(iso: string) {
  return iso.slice(5); // MM-DD
}
function shortWeek(iso: string) {
  // "w/c 22 Jul"
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-AU", { month: "short", timeZone: "UTC" })}`;
}

// ── Simple bar chart (SVG, no library) ────────────────────────────────────

function BarChart({
  data,
  bars,
  formatTip,
  height = 140,
}: {
  data: Record<string, unknown>[];
  bars: { key: string; color: string; label: string }[];
  formatTip?: (d: Record<string, unknown>) => string;
  height?: number;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  if (!data.length) return <p className="text-caption text-charcoal/50 py-6 text-center">No data for this range</p>;

  const maxVal = Math.max(...data.map((d) => bars.reduce((s, b) => s + (Number(d[b.key]) || 0), 0)), 0.01);
  const count = data.length;
  const viewW = 600;
  const barW = Math.max(6, Math.floor((viewW - 20) / count) - 2);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${viewW} ${height + 28}`}
        className="w-full"
        onMouseLeave={() => setTip(null)}
      >
        {data.map((d, i) => {
          const x = 10 + i * ((viewW - 20) / count);
          let yOffset = height;
          const accessibleLabel = formatTip
            ? formatTip(d)
            : bars.map((bar) => `${bar.label}: ${fmt$(Number(d[bar.key]) || 0)}`).join(" · ");
          return (
            <g
              key={i}
              aria-label={accessibleLabel}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
                setTip({ x: rect.left + rect.width / 2, y: rect.top - 8, text: accessibleLabel });
              }}
              className="cursor-default"
            >
              <title>{accessibleLabel}</title>
              {bars.map((b) => {
                const val = Number(d[b.key]) || 0;
                const barH = (val / maxVal) * height;
                yOffset -= barH;
                return (
                  <rect
                    key={b.key}
                    x={x}
                    y={yOffset}
                    width={barW}
                    height={barH}
                    fill={b.color}
                    opacity={0.9}
                  />
                );
              })}
              {count <= 35 && (
                <text
                  x={x + barW / 2}
                  y={height + 14}
                  textAnchor="middle"
                  fontSize={count > 20 ? 7 : 8}
                  fill="#666"
                >
                  {String(d._label ?? "")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div
          className="pointer-events-none fixed z-50 rounded border border-[#dcd6cc] bg-white px-2 py-1 text-caption shadow"
          style={{ left: tip.x, top: tip.y, transform: "translate(-50%, -100%)" }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

// ── Metric card ────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`border p-5 ${accent ? "border-[#1A1A1A] bg-[#1A1A1A] text-white" : "border-[#dcd6cc] bg-white"}`}>
      <p className={`label-caps mb-2 ${accent ? "text-white/60" : "text-charcoal/60"}`}>{label}</p>
      <p className={`font-light text-2xl tracking-tight ${accent ? "text-white" : "text-nearblack"}`}>{value}</p>
      {sub && <p className={`text-caption mt-1 ${accent ? "text-white/50" : "text-charcoal/50"}`}>{sub}</p>}
    </div>
  );
}

// ── Legend dot ─────────────────────────────────────────────────────────────

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-caption text-charcoal/70">
      <span className="h-2.5 w-2.5 shrink-0" style={{ background: color }} />
      {label}
    </span>
  );
}

function SourcePill({ label, status }: { label: string; status: MarketingSourceStatus }) {
  const appearance = {
    connected: { dot: "#55705b", text: "Connected" },
    not_configured: { dot: "#A08C72", text: "Needs setup" },
    error: { dot: "#a13f35", text: "Needs attention" },
  }[status.state];

  return (
    <div
      className="flex min-w-0 items-center gap-2 border border-[#dcd6cc] bg-white px-3 py-2"
      title={status.message}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: appearance.dot }} />
      <span className="truncate text-caption text-charcoal/75">{label}</span>
      <span className="ml-auto whitespace-nowrap text-caption text-charcoal/45">{appearance.text}</span>
    </div>
  );
}

function changeLabel(change: number | null, current: number, previous: number): string {
  if (change == null) return current > 0 && previous === 0 ? "New" : "—";
  if (Math.abs(change) < 0.5) return "No change";
  return `${change > 0 ? "+" : ""}${Math.round(change)}%`;
}

function OrganicPerformanceTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: OrganicPagePerformance[];
  empty: string;
}) {
  return (
    <div className="border border-[#dcd6cc] bg-[#faf9f6] p-4">
      <p className="label-caps mb-3 text-charcoal/60">{title}</p>
      <div className="overflow-x-auto">
        <div className="min-w-[630px] divide-y divide-[#e7e2d9]">
          <div className="grid grid-cols-[2rem_minmax(210px,1fr)_5rem_6rem_4rem_4.5rem] gap-3 pb-2 text-caption text-charcoal/45">
            <span>#</span>
            <span>Page</span>
            <span className="text-right">Clicks</span>
            <span className="text-right">Vs prior</span>
            <span className="text-right">CTR</span>
            <span className="text-right">Position</span>
          </div>
          {rows.map((row, index) => {
            const change = changeLabel(row.clicks_change_pct, row.clicks, row.previous_clicks);
            const positive = (row.clicks_change_pct ?? 0) > 0;
            const negative = (row.clicks_change_pct ?? 0) < 0;
            return (
              <div
                key={row.page}
                className="grid grid-cols-[2rem_minmax(210px,1fr)_5rem_6rem_4rem_4.5rem] items-center gap-3 py-2.5"
              >
                <span className="text-caption text-charcoal/40">{index + 1}</span>
                <a
                  href={`https://www.reslu.com.au${row.page === "/" ? "" : row.page}`}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-body text-nearblack underline-offset-2 hover:underline"
                  title={row.page}
                >
                  {row.page}
                </a>
                <span className="text-right text-body text-nearblack">{row.clicks}</span>
                <span
                  className={`text-right text-caption ${positive ? "text-[#55705b]" : negative ? "text-[#a13f35]" : "text-charcoal/45"}`}
                >
                  {change}
                </span>
                <span className="text-right text-caption text-charcoal/60">{fmtPct(row.ctr)}</span>
                <span className="text-right text-caption text-charcoal/60">{row.position.toFixed(1)}</span>
              </div>
            );
          })}
          {rows.length === 0 && <p className="py-4 text-caption text-charcoal/45">{empty}</p>}
        </div>
      </div>
    </div>
  );
}

function OrganicInsightCard({ insight }: { insight: OrganicOpportunity }) {
  const priority = {
    high: { label: "High opportunity", color: "#a13f35" },
    medium: { label: "Good opportunity", color: "#A08C72" },
    watch: { label: "Watch", color: "#55705b" },
  }[insight.priority];

  return (
    <article className="border border-[#dcd6cc] bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="label-caps" style={{ color: priority.color }}>{priority.label}</span>
        <span className="text-caption text-charcoal/45">Opportunity {insight.score}/100</span>
      </div>
      <p className="mb-1 text-subhead font-medium text-nearblack">{insight.title}</p>
      <a
        href={`https://www.reslu.com.au${insight.page === "/" ? "" : insight.page}`}
        target="_blank"
        rel="noreferrer"
        className="mb-3 block truncate text-caption text-charcoal/55 underline-offset-2 hover:underline"
        title={insight.page}
      >
        {insight.kind === "blog" ? "Blog · " : "Webpage · "}{insight.page}
      </a>
      <p className="mb-3 text-body text-charcoal/70">{insight.reason}</p>
      <div className="border-l-2 border-[#A08C72] pl-3">
        <p className="label-caps mb-1 text-charcoal/50">Recommended action</p>
        <p className="text-body text-nearblack">{insight.action}</p>
      </div>
      <p className="mt-3 text-caption text-[#55705b]">{insight.predicted_impact}</p>
    </article>
  );
}

async function requestMarketingData(
  from: string,
  to: string,
  signal?: AbortSignal
): Promise<MarketingData> {
  const params = new URLSearchParams({ from, to });
  const response = await fetch(`/api/marketing?${params}`, { signal, cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Marketing data failed (${response.status}).`);
  }
  return (await response.json()) as MarketingData;
}

// ── Main dashboard ─────────────────────────────────────────────────────────

export function MarketingDashboard({ initialFrom, initialTo }: MarketingDashboardProps) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [data, setData] = useState<MarketingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await requestMarketingData(f, t));
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Marketing data failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void requestMarketingData(initialFrom, initialTo, controller.signal)
      .then((nextData) => {
        if (active) setData(nextData);
      })
      .catch((loadError: unknown) => {
        if (active && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Marketing data failed.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [initialFrom, initialTo]);

  function apply() {
    void load(from, to);
  }

  const s = data?.summary;
  const googleConnected = data?.sources.google_ads.state === "connected";
  const metaConnected = data?.sources.meta_ads.state === "connected";
  const adsConnected = googleConnected || metaConnected;
  const leadsConnected = data?.sources.leads.state === "connected";

  // Prep chart data
  const dailyChartData = (data?.daily ?? []).map((d) => ({
    ...d,
    _label: shortDate(d.date),
  }));

  const weeklyChartData = (data?.weekly ?? []).map((w) => ({
    ...w,
    _label: shortWeek(w.week),
  }));

  return (
    <div className="space-y-8">
      {/* Date picker */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label-caps mb-1 block text-charcoal/60">From</label>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-[#dcd6cc] bg-white px-3 py-2 text-body text-nearblack focus:border-nearblack focus:outline-none"
          />
        </div>
        <div>
          <label className="label-caps mb-1 block text-charcoal/60">To</label>
          <input
            type="date"
            value={to}
            min={from}
            max={initialTo}
            onChange={(e) => setTo(e.target.value)}
            className="border border-[#dcd6cc] bg-white px-3 py-2 text-body text-nearblack focus:border-nearblack focus:outline-none"
          />
        </div>
        <button
          onClick={apply}
          disabled={loading}
          className="border border-nearblack bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "Apply"}
        </button>
        {/* Quick presets */}
        <div className="flex gap-2">
          {[
            { label: "7d", days: 7 },
            { label: "30d", days: 30 },
            { label: "90d", days: 90 },
          ].map(({ label, days }) => (
            <button
              key={label}
              onClick={() => {
                const f = marketingPresetFrom(initialTo, days);
                setFrom(f);
                setTo(initialTo);
                void load(f, initialTo);
              }}
              className="border border-[#dcd6cc] px-3 py-2 text-caption text-charcoal hover:border-nearblack hover:text-nearblack transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
        {error && <p className="text-caption text-red-700">Error: {error}</p>}
      </div>

      {data && (
        <section aria-label="Marketing data connections" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <SourcePill label="Google Ads" status={data.sources.google_ads} />
          <SourcePill label="Meta Ads" status={data.sources.meta_ads} />
          <SourcePill label="Search Console" status={data.sources.search_console} />
          <SourcePill label="RESLU leads" status={data.sources.leads} />
        </section>
      )}

      {/* Summary cards */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Total spend"
            value={adsConnected ? fmt$(s.total_spend) : "—"}
            sub={
              adsConnected
                ? `Google ${googleConnected ? fmt$(s.google_spend) : "not connected"} · Meta ${metaConnected ? fmt$(s.meta_spend) : "not connected"}`
                : "Connect Google Ads or Meta Ads"
            }
            accent
          />
          <MetricCard
            label="Conversions"
            value={adsConnected ? s.total_conversions.toString() : "—"}
            sub={adsConnected ? "Google Ads + Meta lead actions" : "Ad platforms not connected"}
          />
          <MetricCard
            label="Cost per lead"
            value={adsConnected && leadsConnected && s.cost_per_lead != null ? fmt$(s.cost_per_lead) : "—"}
            sub={
              leadsConnected
                ? `${s.leads} eligible lead${s.leads !== 1 ? "s" : ""} · future leads excluded`
                : "Lead totals unavailable"
            }
          />
          <MetricCard
            label="Click-through rate"
            value={adsConnected
              ? `G ${googleConnected ? fmtPct(s.google_ctr) : "—"} · M ${metaConnected ? fmtPct(s.meta_ctr) : "—"}`
              : "—"}
            sub="Google · Meta"
          />
        </div>
      )}

      {loading && !data && (
        <div className="py-16 text-center text-body text-charcoal/50">Loading…</div>
      )}

      {data && (
        <>
          {/* Daily spend chart */}
          <section className="border border-[#dcd6cc] bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-subhead font-medium text-nearblack">Spend per day</h2>
              <div className="flex gap-4">
                <Dot color="#1A1A1A" label="Google" />
                <Dot color="#A08C72" label="Meta" />
              </div>
            </div>
            <BarChart
              data={dailyChartData}
              bars={[
                { key: "google_spend", color: "#1A1A1A", label: "Google" },
                { key: "meta_spend", color: "#A08C72", label: "Meta" },
              ]}
              formatTip={(d) =>
                `${String(d.date)}  Google ${fmt$(Number(d.google_spend) || 0)}  Meta ${fmt$(Number(d.meta_spend) || 0)}  Total ${fmt$(Number(d.total_spend) || 0)}`
              }
              height={160}
            />
          </section>

          {/* Weekly spend chart */}
          <section className="border border-[#dcd6cc] bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-subhead font-medium text-nearblack">Spend per week</h2>
              <div className="flex gap-4">
                <Dot color="#1A1A1A" label="Google" />
                <Dot color="#A08C72" label="Meta" />
              </div>
            </div>
            <BarChart
              data={weeklyChartData}
              bars={[
                { key: "google_spend", color: "#1A1A1A", label: "Google" },
                { key: "meta_spend", color: "#A08C72", label: "Meta" },
              ]}
              formatTip={(d) =>
                `w/c ${String(d.week)}  Google ${fmt$(Number(d.google_spend) || 0)}  Meta ${fmt$(Number(d.meta_spend) || 0)}  Total ${fmt$(Number(d.total_spend) || 0)}`
              }
              height={160}
            />
          </section>

          {/* Platform breakdown */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="border border-[#dcd6cc] bg-white p-5">
              <p className="label-caps mb-3 text-charcoal/60">Google Ads</p>
              {!googleConnected && (
                <p className="mb-3 text-caption text-charcoal/50">
                  {data.sources.google_ads.message || "Google Ads is not connected."}
                </p>
              )}
              <div className={`space-y-2 ${googleConnected ? "" : "opacity-45"}`}>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Spend</span>
                  <span>{googleConnected ? fmt$(s?.google_spend ?? 0) : "—"}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Conversions</span>
                  <span>{googleConnected ? data.summary.google_conversions : "—"}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">CTR</span>
                  <span>{googleConnected ? fmtPct(s?.google_ctr ?? 0) : "—"}</span>
                </div>
              </div>
            </div>
            <div className="border border-[#dcd6cc] bg-white p-5">
              <p className="label-caps mb-3 text-charcoal/60">Meta Ads</p>
              {!metaConnected && (
                <p className="mb-3 text-caption text-charcoal/50">
                  {data.sources.meta_ads.message || "Meta Ads is not connected."}
                </p>
              )}
              <div className={`space-y-2 ${metaConnected ? "" : "opacity-45"}`}>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Spend</span>
                  <span>{metaConnected ? fmt$(s?.meta_spend ?? 0) : "—"}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Conversions</span>
                  <span>{metaConnected ? data.summary.meta_conversions : "—"}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">CTR</span>
                  <span>{metaConnected ? fmtPct(s?.meta_ctr ?? 0) : "—"}</span>
                </div>
              </div>
            </div>
          </section>

          {/* SEO — Google Search Console */}
          <section className="border border-[#dcd6cc] bg-white p-6">
            <h2 className="text-subhead font-medium text-nearblack mb-1">SEO — Search Console</h2>

            {!data.seo ? (
              <div className="py-8 text-center">
                <p className="text-body text-charcoal/60 mb-2">
                  {data.sources.search_console.state === "not_configured"
                    ? "Search Console needs setup"
                    : "Search Console needs attention"}
                </p>
                <p className="text-caption text-charcoal/40">
                  {data.sources.search_console.message || "No SEO data is available for this range."}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* SEO totals */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mt-4">
                  <MetricCard label="Organic clicks" value={data.seo.totals.clicks.toString()} />
                  <MetricCard label="Impressions" value={data.seo.totals.impressions.toLocaleString()} />
                  <MetricCard label="Organic CTR" value={fmtPct(data.seo.totals.ctr)} />
                  <MetricCard label="Avg. position" value={data.seo.totals.avg_position.toFixed(1)} />
                </div>

                {/* Organic recommendations */}
                <div>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <p className="label-caps text-charcoal/60">Organic actions to take next</p>
                      <p className="mt-1 text-caption text-charcoal/45">
                        Ranked from impressions, position, CTR headroom and movement against {data.seo.comparison.from}–{data.seo.comparison.to}.
                      </p>
                    </div>
                    <p className="text-caption text-charcoal/40">Directional opportunity signals—not guaranteed forecasts.</p>
                  </div>
                  {data.seo.insights.length > 0 ? (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {data.seo.insights.map((insight) => (
                        <OrganicInsightCard key={`${insight.page}-${insight.title}`} insight={insight} />
                      ))}
                    </div>
                  ) : (
                    <p className="border border-[#dcd6cc] bg-[#faf9f6] p-4 text-caption text-charcoal/45">
                      Not enough Search Console demand in this range to form a useful recommendation.
                    </p>
                  )}
                </div>

                {/* Highest-performing pages by type */}
                <div className="grid gap-3 xl:grid-cols-2">
                  <OrganicPerformanceTable
                    title="Highest-performing webpages"
                    rows={data.seo.top_pages}
                    empty="No website-page data for this range."
                  />
                  <OrganicPerformanceTable
                    title="Highest-performing blog articles"
                    rows={data.seo.top_blogs}
                    empty="No blog-article data for this range."
                  />
                </div>

                {/* Top queries */}
                <div>
                  <p className="label-caps mb-3 text-charcoal/60">Top search queries</p>
                  <div className="overflow-x-auto">
                    <div className="min-w-[620px] divide-y divide-[#eee]">
                      {data.seo.top_queries.slice(0, 10).map((q) => (
                        <div key={q.query} className="flex items-center gap-4 py-2.5">
                          <span className="flex-1 text-body text-nearblack truncate">{q.query}</span>
                          <span className="text-caption text-charcoal/60 w-16 text-right">{q.clicks} clicks</span>
                          <span className="text-caption text-charcoal/60 w-20 text-right">{q.impressions.toLocaleString()} impr.</span>
                          <span className="text-caption text-charcoal/60 w-14 text-right">{fmtPct(q.ctr)}</span>
                          <span className="text-caption text-charcoal/50 w-14 text-right">pos {q.position.toFixed(1)}</span>
                        </div>
                      ))}
                      {data.seo.top_queries.length === 0 && (
                        <p className="py-4 text-caption text-charcoal/45">No search queries for this range.</p>
                      )}
                    </div>
                  </div>
                </div>

              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
