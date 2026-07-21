import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

// ── Google Ads ─────────────────────────────────────────────────────────────

async function getGoogleAdsToken(): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? "",
        refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
        grant_type: "refresh_token",
      }),
    });
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchGoogleAds(from: string, to: string) {
  try {
    const accessToken = await getGoogleAdsToken();
    if (!accessToken) return null;

    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID ?? "3357756972";
    const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";

    const query = `
      SELECT
        segments.date,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.ctr,
        metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}'
        AND campaign.status != 'REMOVED'
    `;

    const res = await fetch(
      `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!res.ok) {
      console.error("[marketing] Google Ads API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const rows: any[] = data.results ?? [];

    const byDate: Record<string, { spend: number; clicks: number; impressions: number; conversions: number }> = {};
    for (const row of rows) {
      const date: string = row.segments?.date;
      if (!date) continue;
      if (!byDate[date]) byDate[date] = { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
      byDate[date].spend += (Number(row.metrics?.costMicros) || 0) / 1_000_000;
      byDate[date].clicks += Number(row.metrics?.clicks) || 0;
      byDate[date].impressions += Number(row.metrics?.impressions) || 0;
      byDate[date].conversions += Number(row.metrics?.conversions) || 0;
    }

    const daily = Object.entries(byDate)
      .map(([date, m]) => ({
        date,
        spend: m.spend,
        clicks: m.clicks,
        impressions: m.impressions,
        ctr: m.impressions > 0 ? m.clicks / m.impressions : 0,
        conversions: m.conversions,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const total_spend = daily.reduce((s, d) => s + d.spend, 0);
    const total_conversions = daily.reduce((s, d) => s + d.conversions, 0);
    const total_clicks = daily.reduce((s, d) => s + d.clicks, 0);
    const total_impressions = daily.reduce((s, d) => s + d.impressions, 0);

    return {
      daily,
      total_spend,
      total_conversions,
      ctr: total_impressions > 0 ? total_clicks / total_impressions : 0,
    };
  } catch (e) {
    console.error("[marketing] Google Ads fetch error:", e);
    return null;
  }
}

// ── Meta Ads ───────────────────────────────────────────────────────────────

async function fetchMeta(from: string, to: string) {
  try {
    const accessToken = process.env.META_ACCESS_TOKEN ?? "";
    const adAccountId = process.env.META_AD_ACCOUNT_ID ?? "act_1132427791048457";

    if (!accessToken) return null;

    const params = new URLSearchParams({
      fields: "date_start,spend,clicks,impressions,ctr,actions",
      time_increment: "1",
      time_range: JSON.stringify({ since: from, until: to }),
      access_token: accessToken,
      limit: "200",
    });

    const res = await fetch(`https://graph.facebook.com/v21.0/${adAccountId}/insights?${params}`);

    if (!res.ok) {
      console.error("[marketing] Meta API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const rows: any[] = data.data ?? [];

    const daily = rows
      .map((row) => {
        const conversions = ((row.actions as any[]) ?? [])
          .filter((a) => ["lead", "offsite_conversion.fb_pixel_lead"].includes(a.action_type))
          .reduce((s: number, a: any) => s + Number(a.value || 0), 0);

        return {
          date: row.date_start as string,
          spend: Number(row.spend) || 0,
          clicks: Number(row.clicks) || 0,
          impressions: Number(row.impressions) || 0,
          ctr: Number(row.ctr) || 0,
          conversions,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const total_spend = daily.reduce((s, d) => s + d.spend, 0);
    const total_conversions = daily.reduce((s, d) => s + d.conversions, 0);
    const total_clicks = daily.reduce((s, d) => s + d.clicks, 0);
    const total_impressions = daily.reduce((s, d) => s + d.impressions, 0);

    return {
      daily,
      total_spend,
      total_conversions,
      ctr: total_impressions > 0 ? total_clicks / total_impressions : 0,
    };
  } catch (e) {
    console.error("[marketing] Meta fetch error:", e);
    return null;
  }
}

// ── Google Search Console ──────────────────────────────────────────────────

async function fetchGSC(from: string, to: string) {
  try {
    const clientId = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID ?? "";
    const clientSecret = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET ?? "";
    const refreshToken = process.env.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN ?? "";

    if (!refreshToken || !clientId || !clientSecret) return null;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json();
    const accessToken: string = tokenData.access_token;
    if (!accessToken) return null;

    const siteUrl = "sc-domain:reslu.com.au";
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    const [queryRes, pageRes] = await Promise.all([
      fetch(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: from,
            endDate: to,
            dimensions: ["query"],
            rowLimit: 20,
            orderBy: [{ fieldName: "clicks", sortOrder: "DESCENDING" }],
          }),
        }
      ),
      fetch(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: from,
            endDate: to,
            dimensions: ["page"],
            rowLimit: 10,
            orderBy: [{ fieldName: "clicks", sortOrder: "DESCENDING" }],
          }),
        }
      ),
    ]);

    const [queryData, pageData] = await Promise.all([
      queryRes.ok ? queryRes.json() : { rows: [] },
      pageRes.ok ? pageRes.json() : { rows: [] },
    ]);

    const top_queries = ((queryData.rows ?? []) as any[]).map((r) => ({
      query: r.keys[0] as string,
      clicks: r.clicks as number,
      impressions: r.impressions as number,
      ctr: r.ctr as number,
      position: r.position as number,
    }));

    const pages = ((pageData.rows ?? []) as any[]).map((r) => ({
      page: (r.keys[0] as string).replace(/^https?:\/\/(www\.)?reslu\.com\.au/, "") || "/",
      clicks: r.clicks as number,
      impressions: r.impressions as number,
      ctr: r.ctr as number,
      position: r.position as number,
    }));

    const total_clicks = top_queries.reduce((s, r) => s + r.clicks, 0);
    const total_impressions = top_queries.reduce((s, r) => s + r.impressions, 0);
    const avg_position =
      top_queries.length > 0
        ? top_queries.reduce((s, r) => s + r.position, 0) / top_queries.length
        : 0;

    return {
      top_queries,
      pages,
      totals: {
        clicks: total_clicks,
        impressions: total_impressions,
        ctr: total_impressions > 0 ? total_clicks / total_impressions : 0,
        avg_position,
      },
    };
  } catch (e) {
    console.error("[marketing] GSC fetch error:", e);
    return null;
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (info?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = request.nextUrl;
  const defaultFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const defaultTo = new Date().toISOString().slice(0, 10);
  const from = searchParams.get("from") || defaultFrom;
  const to = searchParams.get("to") || defaultTo;

  const [google, meta, gsc] = await Promise.all([
    fetchGoogleAds(from, to),
    fetchMeta(from, to),
    fetchGSC(from, to),
  ]);

  // Lead count
  const { count: leadCount } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .gte("created_at", from)
    .lte("created_at", `${to}T23:59:59Z`);

  const total_spend = (google?.total_spend ?? 0) + (meta?.total_spend ?? 0);
  const total_conversions = (google?.total_conversions ?? 0) + (meta?.total_conversions ?? 0);
  const leads = leadCount ?? 0;
  const cost_per_lead = leads > 0 ? total_spend / leads : null;

  // Merge daily rows
  const dateSet = new Set([
    ...(google?.daily.map((d) => d.date) ?? []),
    ...(meta?.daily.map((d) => d.date) ?? []),
  ]);
  const daily = Array.from(dateSet)
    .sort()
    .map((date) => {
      const g = google?.daily.find((d) => d.date === date);
      const m = meta?.daily.find((d) => d.date === date);
      return {
        date,
        google_spend: g?.spend ?? 0,
        meta_spend: m?.spend ?? 0,
        total_spend: (g?.spend ?? 0) + (m?.spend ?? 0),
        conversions: (g?.conversions ?? 0) + (m?.conversions ?? 0),
      };
    });

  // Weekly rollup (Mon–Sun)
  const weekMap: Record<string, { week: string; total_spend: number; google_spend: number; meta_spend: number; conversions: number }> = {};
  for (const d of daily) {
    const dt = new Date(`${d.date}T00:00:00Z`);
    const dow = dt.getUTCDay(); // 0=Sun
    const offset = dow === 0 ? 6 : dow - 1;
    const mon = new Date(dt);
    mon.setUTCDate(dt.getUTCDate() - offset);
    const wk = mon.toISOString().slice(0, 10);
    if (!weekMap[wk]) weekMap[wk] = { week: wk, total_spend: 0, google_spend: 0, meta_spend: 0, conversions: 0 };
    weekMap[wk].total_spend += d.total_spend;
    weekMap[wk].google_spend += d.google_spend;
    weekMap[wk].meta_spend += d.meta_spend;
    weekMap[wk].conversions += d.conversions;
  }
  const weekly = Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week));

  return NextResponse.json({
    from,
    to,
    summary: {
      total_spend,
      total_conversions,
      cost_per_lead,
      leads,
      google_spend: google?.total_spend ?? 0,
      meta_spend: meta?.total_spend ?? 0,
      google_ctr: google?.ctr ?? 0,
      meta_ctr: meta?.ctr ?? 0,
    },
    daily,
    weekly,
    seo: gsc,
  });
}
