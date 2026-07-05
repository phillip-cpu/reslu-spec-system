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

  const isPublicPath =
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
    pathname.startsWith("/trade") ||
    pathname.startsWith("/api/trade") ||
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
