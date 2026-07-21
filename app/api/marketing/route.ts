import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import {
  adelaideUtcRange,
  EXCLUDED_MARKETING_LEAD_STAGE,
  mergeAdDailyMetrics,
  metaLeadConversions,
  parseMarketingRange,
  rollupMarketingWeeks,
  type AdDailyMetric,
  type MarketingSourceState,
  type MarketingSourceStatus,
} from "@/lib/marketing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SourceResult<T> {
  data: T | null;
  status: MarketingSourceStatus;
}

interface AdSourceData {
  daily: AdDailyMetric[];
  total_spend: number;
  total_conversions: number;
  ctr: number;
}

interface GoogleAdsRow {
  segments?: { date?: string };
  metrics?: {
    costMicros?: string | number;
    clicks?: string | number;
    impressions?: string | number;
    conversions?: string | number;
  };
}

interface GoogleAdsResponse {
  results?: GoogleAdsRow[];
  nextPageToken?: string;
}

interface MetaInsightsRow {
  date_start?: string;
  spend?: string | number;
  clicks?: string | number;
  impressions?: string | number;
  actions?: unknown;
}

interface MetaInsightsResponse {
  data?: MetaInsightsRow[];
  paging?: { cursors?: { after?: string }; next?: string };
}

interface SearchConsoleRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface SearchConsoleResponse {
  rows?: SearchConsoleRow[];
}

interface SearchConsoleData {
  top_queries: Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  pages: Array<{
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  totals: { clicks: number; impressions: number; ctr: number; avg_position: number };
}

function sourceStatus(state: MarketingSourceState, message?: string): MarketingSourceStatus {
  return { state, ...(message ? { message } : {}) };
}

function missingEnvironment(names: string[]): string[] {
  return names.filter((name) => !process.env[name]?.trim());
}

async function jsonBody<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// ── Google Ads ─────────────────────────────────────────────────────────────

async function fetchGoogleAds(from: string, to: string): Promise<SourceResult<AdSourceData>> {
  const required = [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_CUSTOMER_ID",
  ];
  const missing = missingEnvironment(required);
  if (missing.length > 0) {
    return {
      data: null,
      status: sourceStatus("not_configured", "Add Google Ads credentials in Vercel."),
    };
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
        refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const tokenData = await jsonBody<{ access_token?: string }>(tokenResponse);
    if (!tokenResponse.ok || !tokenData?.access_token) {
      console.error("[marketing] Google Ads OAuth failed:", tokenResponse.status);
      return {
        data: null,
        status: sourceStatus("error", "Google Ads authentication needs attention."),
      };
    }

    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "");
    if (!/^\d+$/.test(customerId)) {
      return {
        data: null,
        status: sourceStatus("error", "Google Ads customer ID is invalid."),
      };
    }

    const configuredVersion = process.env.GOOGLE_ADS_API_VERSION?.trim() || "v24";
    const apiVersion = /^v\d+$/.test(configuredVersion) ? configuredVersion : "v24";
    const query = `
      SELECT
        segments.date,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}'
        AND campaign.status != 'REMOVED'
    `;

    const rows: GoogleAdsRow[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    do {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokenData.access_token}`,
        "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
        "Content-Type": "application/json",
      };
      const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "");
      if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

      const response = await fetch(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        }
      );
      const page = await jsonBody<GoogleAdsResponse>(response);
      if (!response.ok || !page) {
        console.error("[marketing] Google Ads API failed:", response.status);
        return {
          data: null,
          status: sourceStatus("error", "Google Ads data could not be refreshed."),
        };
      }
      rows.push(...(page.results ?? []));
      pageToken = page.nextPageToken;
      pageCount += 1;
    } while (pageToken && pageCount < 20);

    if (pageToken) {
      return {
        data: null,
        status: sourceStatus("error", "Google Ads returned more rows than the reporting limit."),
      };
    }

    const byDate = new Map<
      string,
      { spend: number; clicks: number; impressions: number; conversions: number }
    >();
    for (const row of rows) {
      const date = row.segments?.date;
      if (!date) continue;
      const current = byDate.get(date) ?? { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
      current.spend += (Number(row.metrics?.costMicros) || 0) / 1_000_000;
      current.clicks += Number(row.metrics?.clicks) || 0;
      current.impressions += Number(row.metrics?.impressions) || 0;
      current.conversions += Number(row.metrics?.conversions) || 0;
      byDate.set(date, current);
    }

    const daily: AdDailyMetric[] = [...byDate.entries()]
      .map(([date, metrics]) => ({
        date,
        spend: metrics.spend,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        ctr: metrics.impressions > 0 ? metrics.clicks / metrics.impressions : 0,
        conversions: metrics.conversions,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalSpend = daily.reduce((sum, row) => sum + row.spend, 0);
    const totalConversions = daily.reduce((sum, row) => sum + row.conversions, 0);
    const totalClicks = daily.reduce((sum, row) => sum + row.clicks, 0);
    const totalImpressions = daily.reduce((sum, row) => sum + row.impressions, 0);
    return {
      data: {
        daily,
        total_spend: totalSpend,
        total_conversions: totalConversions,
        ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      },
      status: sourceStatus("connected"),
    };
  } catch (error) {
    console.error("[marketing] Google Ads fetch failed:", error);
    return {
      data: null,
      status: sourceStatus("error", "Google Ads timed out or could not be reached."),
    };
  }
}

// ── Meta Ads ───────────────────────────────────────────────────────────────

async function fetchMeta(from: string, to: string): Promise<SourceResult<AdSourceData>> {
  const missing = missingEnvironment(["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"]);
  if (missing.length > 0) {
    return {
      data: null,
      status: sourceStatus("not_configured", "Add Meta Ads credentials in Vercel."),
    };
  }

  try {
    const rows: MetaInsightsRow[] = [];
    let after: string | undefined;
    let pageCount = 0;
    do {
      const params = new URLSearchParams({
        fields: "date_start,spend,clicks,impressions,actions",
        time_increment: "1",
        time_range: JSON.stringify({ since: from, until: to }),
        limit: "200",
        ...(after ? { after } : {}),
      });
      const response = await fetch(
        `https://graph.facebook.com/v21.0/${process.env.META_AD_ACCOUNT_ID}/insights?${params}`,
        {
          headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        }
      );
      const page = await jsonBody<MetaInsightsResponse>(response);
      if (!response.ok || !page) {
        console.error("[marketing] Meta Ads API failed:", response.status);
        return {
          data: null,
          status: sourceStatus("error", "Meta Ads data could not be refreshed."),
        };
      }
      rows.push(...(page.data ?? []));
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
      pageCount += 1;
    } while (after && pageCount < 20);

    if (after) {
      return {
        data: null,
        status: sourceStatus("error", "Meta Ads returned more rows than the reporting limit."),
      };
    }

    const daily: AdDailyMetric[] = rows
      .flatMap((row) => {
        if (!row.date_start) return [];
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        return [{
          date: row.date_start,
          spend: Number(row.spend) || 0,
          clicks,
          impressions,
          ctr: impressions > 0 ? clicks / impressions : 0,
          conversions: metaLeadConversions(row.actions),
        }];
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalSpend = daily.reduce((sum, row) => sum + row.spend, 0);
    const totalConversions = daily.reduce((sum, row) => sum + row.conversions, 0);
    const totalClicks = daily.reduce((sum, row) => sum + row.clicks, 0);
    const totalImpressions = daily.reduce((sum, row) => sum + row.impressions, 0);
    return {
      data: {
        daily,
        total_spend: totalSpend,
        total_conversions: totalConversions,
        ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      },
      status: sourceStatus("connected"),
    };
  } catch (error) {
    console.error("[marketing] Meta Ads fetch failed:", error);
    return {
      data: null,
      status: sourceStatus("error", "Meta Ads timed out or could not be reached."),
    };
  }
}

// ── Google Search Console ──────────────────────────────────────────────────

async function fetchSearchConsole(from: string, to: string): Promise<SourceResult<SearchConsoleData>> {
  const required = [
    "GOOGLE_SEARCH_CONSOLE_CLIENT_ID",
    "GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET",
    "GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN",
  ];
  if (missingEnvironment(required).length > 0) {
    return {
      data: null,
      status: sourceStatus("not_configured", "Connect Google Search Console in Vercel."),
    };
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET!,
        refresh_token: process.env.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const tokenData = await jsonBody<{ access_token?: string }>(tokenResponse);
    if (!tokenResponse.ok || !tokenData?.access_token) {
      console.error("[marketing] Search Console OAuth failed:", tokenResponse.status);
      return {
        data: null,
        status: sourceStatus("error", "Search Console authentication needs attention."),
      };
    }

    const siteUrl = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL || "sc-domain:reslu.com.au";
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const headers = {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
    };
    const requestBody = (body: Record<string, unknown>) =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ startDate: from, endDate: to, dataState: "all", ...body }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });

    // A dimensionless row is the correct site-wide total. Summing the
    // top queries would understate clicks/impressions and distort position.
    const [totalsResponse, queriesResponse, pagesResponse] = await Promise.all([
      requestBody({ rowLimit: 1 }),
      requestBody({ dimensions: ["query"], rowLimit: 20 }),
      requestBody({ dimensions: ["page"], rowLimit: 10 }),
    ]);
    if (!totalsResponse.ok || !queriesResponse.ok || !pagesResponse.ok) {
      console.error("[marketing] Search Console API failed:", {
        totals: totalsResponse.status,
        queries: queriesResponse.status,
        pages: pagesResponse.status,
      });
      return {
        data: null,
        status: sourceStatus("error", "Search Console data could not be refreshed."),
      };
    }

    const [totalsData, queriesData, pagesData] = await Promise.all([
      jsonBody<SearchConsoleResponse>(totalsResponse),
      jsonBody<SearchConsoleResponse>(queriesResponse),
      jsonBody<SearchConsoleResponse>(pagesResponse),
    ]);
    if (!totalsData || !queriesData || !pagesData) {
      return {
        data: null,
        status: sourceStatus("error", "Search Console returned an unreadable response."),
      };
    }

    const total = totalsData.rows?.[0];
    const topQueries = (queriesData.rows ?? []).flatMap((row) => {
      const query = row.keys?.[0];
      if (!query) return [];
      return [{
        query,
        clicks: Number(row.clicks) || 0,
        impressions: Number(row.impressions) || 0,
        ctr: Number(row.ctr) || 0,
        position: Number(row.position) || 0,
      }];
    });
    const pages = (pagesData.rows ?? []).flatMap((row) => {
      const page = row.keys?.[0];
      if (!page) return [];
      return [{
        page: page.replace(/^https?:\/\/(www\.)?reslu\.com\.au/, "") || "/",
        clicks: Number(row.clicks) || 0,
        impressions: Number(row.impressions) || 0,
        ctr: Number(row.ctr) || 0,
        position: Number(row.position) || 0,
      }];
    });

    return {
      data: {
        top_queries: topQueries,
        pages,
        totals: {
          clicks: Number(total?.clicks) || 0,
          impressions: Number(total?.impressions) || 0,
          ctr: Number(total?.ctr) || 0,
          avg_position: Number(total?.position) || 0,
        },
      },
      status: sourceStatus("connected"),
    };
  } catch (error) {
    console.error("[marketing] Search Console fetch failed:", error);
    return {
      data: null,
      status: sourceStatus("error", "Search Console timed out or could not be reached."),
    };
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const range = parseMarketingRange(
    request.nextUrl.searchParams.get("from"),
    request.nextUrl.searchParams.get("to")
  );
  if (!range.ok) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  const leadRange = adelaideUtcRange(range.from, range.to);
  const leadQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .neq("stage", EXCLUDED_MARKETING_LEAD_STAGE)
    .gte("received_at", leadRange.start)
    .lt("received_at", leadRange.endExclusive);

  const [google, meta, searchConsole, leadResult] = await Promise.all([
    fetchGoogleAds(range.from, range.to),
    fetchMeta(range.from, range.to),
    fetchSearchConsole(range.from, range.to),
    leadQuery,
  ]);

  const leadStatus = leadResult.error
    ? sourceStatus("error", "Lead totals could not be loaded.")
    : sourceStatus("connected");
  if (leadResult.error) {
    console.error("[marketing] Lead count failed:", leadResult.error.message);
  }

  const googleSpend = google.data?.total_spend ?? 0;
  const metaSpend = meta.data?.total_spend ?? 0;
  const googleConversions = google.data?.total_conversions ?? 0;
  const metaConversions = meta.data?.total_conversions ?? 0;
  const leads = leadResult.error ? 0 : (leadResult.count ?? 0);
  const totalSpend = googleSpend + metaSpend;
  const daily = mergeAdDailyMetrics(google.data?.daily, meta.data?.daily);

  return NextResponse.json(
    {
      from: range.from,
      to: range.to,
      generated_at: new Date().toISOString(),
      sources: {
        google_ads: google.status,
        meta_ads: meta.status,
        search_console: searchConsole.status,
        leads: leadStatus,
      },
      summary: {
        total_spend: totalSpend,
        total_conversions: googleConversions + metaConversions,
        cost_per_lead: leads > 0 ? totalSpend / leads : null,
        leads,
        google_spend: googleSpend,
        meta_spend: metaSpend,
        google_conversions: googleConversions,
        meta_conversions: metaConversions,
        google_ctr: google.data?.ctr ?? 0,
        meta_ctr: meta.data?.ctr ?? 0,
      },
      daily,
      weekly: rollupMarketingWeeks(daily),
      seo: searchConsole.data,
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}
