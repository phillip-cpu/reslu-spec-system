"use client";

import { useEffect, useState, useCallback } from "react";

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

interface SEOPage {
  page: string;
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
    google_ctr: number;
    meta_ctr: number;
  };
  daily: DailyRow[];
  weekly: WeeklyRow[];
  seo: {
    top_queries: SEOQuery[];
    pages: SEOPage[];
    totals: { clicks: number; impressions: number; ctr: number; avg_position: number };
  } | null;
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
  data: Record<string, any>[];
  bars: { key: string; color: string; label: string }[];
  formatTip?: (d: Record<string, any>) => string;
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
          return (
            <g
              key={i}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
                const text = formatTip ? formatTip(d) : bars.map((b) => `${b.label}: ${fmt$(Number(d[b.key]) || 0)}`).join(" · ");
                setTip({ x: rect.left + rect.width / 2, y: rect.top - 8, text });
              }}
              className="cursor-default"
            >
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
                  {d._label ?? ""}
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

// ── Main dashboard ─────────────────────────────────────────────────────────

export function MarketingDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(thirtyAgo);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<MarketingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/marketing?from=${f}&to=${t}`);
      if (!res.ok) throw new Error(`${res.status}`);
      setData(await res.json());
    } catch (e: any) {
      setError(e.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(from, to);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function apply() {
    void load(from, to);
  }

  const s = data?.summary;

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
            max={today}
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
                const f = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
                setFrom(f);
                setTo(today);
                void load(f, today);
              }}
              className="border border-[#dcd6cc] px-3 py-2 text-caption text-charcoal hover:border-nearblack hover:text-nearblack transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
        {error && <p className="text-caption text-red-700">Error: {error}</p>}
      </div>

      {/* Summary cards */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Total spend"
            value={fmt$(s.total_spend)}
            sub={`Google ${fmt$(s.google_spend)} · Meta ${fmt$(s.meta_spend)}`}
            accent
          />
          <MetricCard
            label="Conversions"
            value={s.total_conversions.toString()}
            sub="Google Ads + Meta combined"
          />
          <MetricCard
            label="Cost per lead"
            value={s.cost_per_lead != null ? fmt$(s.cost_per_lead) : "—"}
            sub={`${s.leads} lead${s.leads !== 1 ? "s" : ""} in pipeline`}
          />
          <MetricCard
            label="Click-through rate"
            value={`G ${fmtPct(s.google_ctr)} · M ${fmtPct(s.meta_ctr)}`}
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
                `${d.date}  Google ${fmt$(d.google_spend)}  Meta ${fmt$(d.meta_spend)}  Total ${fmt$(d.total_spend)}`
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
                `w/c ${d.week}  Google ${fmt$(d.google_spend)}  Meta ${fmt$(d.meta_spend)}  Total ${fmt$(d.total_spend)}`
              }
              height={160}
            />
          </section>

          {/* Platform breakdown */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="border border-[#dcd6cc] bg-white p-5">
              <p className="label-caps mb-3 text-charcoal/60">Google Ads</p>
              <div className="space-y-2">
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Spend</span>
                  <span className="font-medium">{fmt$(s?.google_spend ?? 0)}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Conversions</span>
                  <span className="font-medium">{data.summary.total_conversions}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">CTR</span>
                  <span className="font-medium">{fmtPct(s?.google_ctr ?? 0)}</span>
                </div>
              </div>
            </div>
            <div className="border border-[#dcd6cc] bg-white p-5">
              <p className="label-caps mb-3 text-charcoal/60">Meta Ads</p>
              <div className="space-y-2">
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Spend</span>
                  <span className="font-medium">{fmt$(s?.meta_spend ?? 0)}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">Conversions</span>
                  <span className="font-medium">{data.summary.total_conversions}</span>
                </div>
                <div className="flex justify-between text-body">
                  <span className="text-charcoal/70">CTR</span>
                  <span className="font-medium">{fmtPct(s?.meta_ctr ?? 0)}</span>
                </div>
              </div>
            </div>
          </section>

          {/* SEO — Google Search Console */}
          <section className="border border-[#dcd6cc] bg-white p-6">
            <h2 className="text-subhead font-medium text-nearblack mb-1">SEO — Search Console</h2>

            {!data.seo ? (
              <div className="py-8 text-center">
                <p className="text-body text-charcoal/60 mb-2">Search Console not connected</p>
                <p className="text-caption text-charcoal/40">Run <code className="bg-[#f5f2ee] px-1">node google-ads/gsc-setup-oauth.js</code> on the Mac mini to connect</p>
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

                {/* Top queries */}
                <div>
                  <p className="label-caps mb-3 text-charcoal/60">Top search queries</p>
                  <div className="divide-y divide-[#eee]">
                    {data.seo.top_queries.slice(0, 10).map((q) => (
                      <div key={q.query} className="flex items-center gap-4 py-2.5">
                        <span className="flex-1 text-body text-nearblack truncate">{q.query}</span>
                        <span className="text-caption text-charcoal/60 w-16 text-right">{q.clicks} clicks</span>
                        <span className="text-caption text-charcoal/60 w-20 text-right">{q.impressions.toLocaleString()} impr.</span>
                        <span className="text-caption text-charcoal/60 w-14 text-right">{fmtPct(q.ctr)}</span>
                        <span className="text-caption text-charcoal/50 w-14 text-right">pos {q.position.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top pages */}
                <div>
                  <p className="label-caps mb-3 text-charcoal/60">Landing page performance</p>
                  <div className="divide-y divide-[#eee]">
                    {data.seo.pages.slice(0, 10).map((p) => (
                      <div key={p.page} className="flex items-center gap-4 py-2.5">
                        <span className="flex-1 text-body text-nearblack truncate font-mono text-sm">{p.page || "/"}</span>
                        <span className="text-caption text-charcoal/60 w-16 text-right">{p.clicks} clicks</span>
                        <span className="text-caption text-charcoal/60 w-20 text-right">{p.impressions.toLocaleString()} impr.</span>
                        <span className="text-caption text-charcoal/60 w-14 text-right">{fmtPct(p.ctr)}</span>
                        <span className="text-caption text-charcoal/50 w-14 text-right">pos {p.position.toFixed(1)}</span>
                      </div>
                    ))}
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
