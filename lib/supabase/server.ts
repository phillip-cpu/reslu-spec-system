import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";

/**
 * Server Supabase client for use in Server Components, Route Handlers,
 * and Server Actions. Reads/writes the session via cookies. Uses the
 * public anon key — RLS applies. Do not use for portal/service-role
 * queries; see createServiceRoleClient below.
 */
export async function createClient() {
  const cookieStore = await cookies();

  // Agent/API access (Aria via MCP): a Bearer token in the Authorization
  // header authenticates instead of session cookies. supabase-js resolves
  // auth.getUser() against the provided JWT, and RLS applies to that
  // user exactly as it would to a cookie session. Cookie flow is
  // completely unchanged when the header is absent.
  // NOTE: requires the middleware to let Authorization-bearing requests
  // through to route handlers (middleware is owned on-machine).
  const headerStore = await headers();
  const authHeader = headerStore.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const jwt = authHeader.slice("Bearer ".length);
    return createSupabaseJsClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );
}

/**
 * Service-role Supabase client. Bypasses RLS entirely — server-side
 * only, never imported into client code or exposed to the browser.
 *
 * Used for: client portal routes (token lookup instead of auth session).
 *
 * BUILD-SPEC.md §Security (non-negotiable): portal approve/flag routes
 * MUST verify the item belongs to the project matching the token before
 * acting on it. That check must happen in the route handler itself —
 * this client alone does not enforce it.
 */
export function createServiceRoleClient() {
  return createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
