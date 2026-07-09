import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { loadBriefPageHtml } from "@/lib/brief-page";

export const runtime = "nodejs";

/**
 * GET /brief/[token] — public, unauthenticated pre-visit questionnaire
 * page (docs/RESLU-lead-flow-brief.md build task 1). Same trust model
 * as /trade/[token] and /portal/[token]: an unguessable token
 * (leads.brief_token — 64-char hex, minted lazily by
 * lib/lead-brief.ts's ensureBriefToken()) is the security boundary,
 * not a hidden route. Rate-limited by IP+token, noindex, service-role
 * client (bypasses RLS — this route is NOT an authenticated team
 * session, same reasoning as every other tokened public page in this
 * codebase).
 *
 * Serves emails/brief/project-brief.html VERBATIM (lib/brief-page.ts's
 * loadBriefPageHtml() — read off disk once, cached) — its submit
 * handler already posts to /api/brief-submit/[token] directly (wired
 * in the file itself, reading the token from location.pathname), and
 * the page has no server-side merge values (see that module's own
 * header comment for why), so every valid token serves the exact same
 * cached HTML.
 *
 * MIDDLEWARE NOTE: lib/supabase/middleware.ts (protected — read-only
 * for this agent) does NOT currently allowlist `/brief` or
 * `/api/brief-submit` in its isPublicPath check (verified by reading
 * that file before writing this route — only /login, /portal,
 * /api/portal, /api/digest, /trade, /api/trade, and static asset
 * prefixes are public today). Without that allowlist entry, an
 * unauthenticated request to this route is redirected to /login by the
 * middleware BEFORE it ever reaches this handler. This is a KNOWN GAP,
 * documented (not silently worked around) per this round's own build
 * instructions — see this round's final report + README.md/docs/API.md
 * "Lead flow" sections for the exact one-line addition CC needs to
 * make to lib/supabase/middleware.ts's isPublicPath:
 *
 *   pathname.startsWith("/brief") ||
 *   pathname.startsWith("/api/brief-submit") ||
 *
 * (placed alongside the existing /trade + /api/trade lines). This
 * route and POST /api/brief-submit/[token] are built and fully working
 * once that one line lands — nothing else about either route depends
 * on it.
 */
// NOTE: this is a Route Handler, not a page.tsx — Next's `export const
// metadata` convention (used by app/trade/[token]/page.tsx for the
// same noindex intent) has no effect here. The `X-Robots-Tag` response
// header set below is the correct, equivalent mechanism for a raw
// NextResponse.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`brief-page:${token}:${clientIp}`);
  if (!limit.ok) {
    return new NextResponse("Not found", { status: 404 });
  }

  const supabase = createServiceRoleClient();
  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("brief_token", token)
    .is("deleted_at", null)
    .maybeSingle();

  if (!lead) {
    return new NextResponse("Not found", { status: 404 });
  }

  let html: string;
  try {
    html = await loadBriefPageHtml();
  } catch {
    return new NextResponse("This page could not be loaded. Please try again shortly.", {
      status: 500,
    });
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    },
  });
}
