import type { NextRequest } from "next/server";
import { partnerLeadScope, summarizePartnerLeads } from "@/lib/partner-lead-access";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const form = '<form method="post"><label for="key">Access key</label> <input type="password" id="key" name="key" autocomplete="off" required minlength="43" maxlength="43"> <button type="submit">Open report</button></form>';
function page(body: string, status = 200) {
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RESLU | Partner reporting</title><main><h1>RESLU lead reporting</h1>' +
    body + '</main></html>',
    { status, headers },
  );
}

export function GET() {
  return page(form);
}

async function readForm(request: NextRequest): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let source = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return source + decoder.decode();
      size += value.byteLength;
      if (size > 64) {
        await reader.cancel();
        return null;
      }
      source += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`partner-report:${ip}`, 10, 60_000).ok) {
    return page("<p>Too many requests. Try again in a minute.</p>", 429);
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== process.env.PARTNER_REPORT_ORIGIN) return page("<p>Invalid request.</p>", 403);
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return page("<p>Invalid request.</p>", 400);
  }
  // A legitimate 43-byte access key posts as 47 ASCII bytes including "key=".
  const source = await readForm(request);
  if (source === null) return page("<p>Invalid request.</p>", 400);
  const keys = new URLSearchParams(source).getAll("key");
  const scope = keys.length === 1 ? partnerLeadScope(keys[0], process.env) : null;
  if (!scope) return page("<p>Access unavailable. Check your key.</p>" + form, 401);

  try {
    const { data, error } = await createServiceRoleClient()
      .from("leads")
      .select("utm_campaign,stage")
      .is("deleted_at", null)
      .in("utm_campaign", scope.campaigns)
      .gte("received_at", scope.since)
      .limit(1000);
    if (error || !data || data.length === 1000) {
      return page("<p>Report unavailable. Please contact RESLU.</p>", 503);
    }
    const report = summarizePartnerLeads(data, scope.campaigns);
    // Campaign keys are restricted to ASCII alphanumerics/dashes/underscores;
    // stage labels come from a fixed enum and counts are generated locally.
    const rows = report.map(r => `<tr><td>${r.campaign}</td><td>${r.stage}</td><td>${r.count}</td></tr>`).join("");
    return page(rows
      ? '<table><thead><tr><th>Campaign</th><th>Lead stage</th><th>Count</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p>No leads match the approved campaigns in this reporting period.</p>');
  } catch {
    return page("<p>Report unavailable. Please contact RESLU.</p>", 503);
  }
}
