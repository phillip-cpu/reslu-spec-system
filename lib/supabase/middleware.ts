import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth middleware helper. Refreshes the Supabase session and redirects
 * unauthenticated users to /login for any route outside the public
 * allowlist (login page, client portal, static assets).
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: avoid writing logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard
  // to debug issues with users being randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Agent/API access (Aria via MCP, see lib/supabase/server.ts's
  // createClient()): a request presenting a Bearer token authenticates
  // via that JWT instead of a session cookie, so it never reaches this
  // point with a cookie-derived `user`. Scoped to /api/** only (Aria's
  // MCP tools are thin fetches to the REST API, never dashboard page
  // loads) — the real authentication/authorization decision still
  // happens inside the route handler itself via createClient() +
  // .auth.getUser(), exactly like the CRON_SECRET-gated routes below;
  // this only avoids bouncing a Bearer-bearing API request to /login
  // before it can reach that check.
  const isBearerApiRequest =
    pathname.startsWith("/api/") &&
    !!request.headers.get("authorization")?.startsWith("Bearer ");

  const isPublicPath =
    isBearerApiRequest ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/portal") ||
    pathname.startsWith("/api/portal") ||
    // Digest flush: self-authenticates (GET via CRON_SECRET for Vercel
    // Cron, POST via session) — must skip the auth-redirect so the
    // cookieless cron GET reaches the handler instead of bouncing to
    // /login. (Re-added — do not remove: the digest cron breaks without it.)
    pathname.startsWith("/api/digest") ||
    // Trade portal (Week 11): /trade/[token] is a public, token-gated page
    // (like /portal); /api/trade/[token]/respond validates the token itself;
    // /api/trade-reminders self-authenticates via CRON_SECRET. All must skip
    // the auth-redirect so trades (no session) and Vercel Cron reach them.
    //
    // Boundary-aware, not a bare startsWith("/trade") — that used to also
    // match /trade-requests/[id] (the admin grouped-trade-booking detail
    // PAGE, migration 049) and /api/trade-requests/* (its admin API),
    // silently exempting them from the login redirect by string-prefix
    // coincidence rather than intent. The admin API routes already do
    // their own auth.getUser() 401 check so this was never a live data
    // leak, but the admin PAGE itself has no such check and would have
    // rendered its shell for an anonymous visitor. Every entry below is
    // either an exact path or requires a "/" immediately after the
    // matched segment, so "/trade-requests" can never satisfy a
    // "/trade" or "/trade-request" check.
    pathname === "/trade" ||
    pathname.startsWith("/trade/") ||
    pathname === "/api/trade" ||
    pathname.startsWith("/api/trade/") ||
    pathname.startsWith("/api/trade-reminders") ||
    // Grouped trade booking round (r20, migration 049): /trade-request/
    // [token] (singular) is the public, token-gated multi-line response
    // page; /api/trade-request/[token]/* validates the token itself.
    // Deliberately does NOT cover /trade-requests (plural) — the admin
    // surfaces for this same feature — see the boundary-aware note above.
    pathname === "/trade-request" ||
    pathname.startsWith("/trade-request/") ||
    pathname === "/api/trade-request" ||
    pathname.startsWith("/api/trade-request/") ||
    // Fee proposal phase (r23, migration 051): /proposal/[token]
    // (singular) is the public, token-gated client signing page (also
    // the Builder UI's own "Live preview" link, reachable before Send);
    // /api/proposal/[token]/accept validates the token itself.
    // Deliberately does NOT cover /proposals or /api/proposals (plural)
    // — the admin builder/list surfaces for this same feature — same
    // boundary-aware singular/plural split as /trade-request above.
    pathname === "/proposal" ||
    pathname.startsWith("/proposal/") ||
    pathname === "/api/proposal" ||
    pathname.startsWith("/api/proposal/") ||
    // Lead flow round (048): /brief/[token] is a public, token-gated
    // pre-visit questionnaire page (same shape as /portal, /trade
    // above); /api/brief-submit/[token] validates the token itself.
    // Without this, every lead following their emailed brief link gets
    // bounced to /login before the route handler ever runs.
    pathname.startsWith("/brief") ||
    pathname.startsWith("/api/brief-submit") ||
    // Address Book insurance request: public token-gated upload page
    // and its two upload APIs. The admin send endpoint stays below
    // /api/contacts/** and therefore remains session-protected.
    pathname === "/insurance" ||
    pathname.startsWith("/insurance/") ||
    pathname === "/api/insurance-request" ||
    pathname.startsWith("/api/insurance-request/") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/reslu-logo") ||
    pathname.startsWith("/fonts");

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // IMPORTANT: you must return the supabaseResponse object as it is, or
  // the browser and server will get out of sync, ending the user's
  // session prematurely.
  return supabaseResponse;
}
