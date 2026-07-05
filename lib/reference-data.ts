import { unstable_cache, revalidateTag } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/server";
import type { Category, Profile } from "@/types";

/**
 * Phase 14A caching — stable reference data.
 * BUILD-SPEC.md Phase 14 "Speed": "caching (stable data + portal
 * revalidate + PDF cache)".
 *
 * `categories` and the team `profiles` roster change rarely (admin
 * edits in Settings only) but were being re-queried on every request
 * that needed them — the dashboard, the project page, the library
 * page, the settings page, and the PDF route all ran their own
 * `select("*")` against these two tables per request. Wrapping them in
 * `unstable_cache` with a generous revalidate window turns that into a
 * cache hit for the overwhelming majority of requests, with an
 * explicit `revalidateTag` call from every route that mutates either
 * table so an admin's category rename / role change is never stale for
 * longer than the time it takes that one PATCH/POST/DELETE to
 * complete.
 *
 * Deliberately NOT used for anything per-project or per-user (items,
 * board tasks, portal data, etc.) — those change constantly and are
 * already scoped/filtered per request; caching them would be a
 * correctness risk for no real benefit. This module is scoped
 * narrowly to the two genuinely-global, rarely-mutated reference
 * tables named in this task's brief ("categories, profiles list").
 *
 * Each function uses the service-role client, not the session-cookie
 * client — `unstable_cache` forbids touching dynamic APIs like cookies()
 * inside its callback (Next.js throws at request time otherwise). Safe
 * here: both tables' RLS policy is the same permissive "team_all" for
 * any authenticated session, and every current caller of
 * getCategories()/getProfiles() already sits behind an authenticated
 * dashboard route, so the cached rows are identical to what the
 * session-cookie client would have returned for any team member.
 */

const REVALIDATE_SECONDS = 300; // 5 minutes — short enough that even a missed revalidateTag call self-heals quickly

export const CATEGORIES_CACHE_TAG = "categories";
export const PROFILES_CACHE_TAG = "profiles";

const getCachedCategories = unstable_cache(
  async (): Promise<Category[]> => {
    // Service-role client, not the session-cookie client: unstable_cache
    // forbids touching dynamic APIs like cookies() inside its callback
    // (Next.js throws "used cookies() inside a function cached with
    // unstable_cache()" at request time). Safe here — every current
    // caller of getCategories() already sits behind an authenticated
    // dashboard route, and categories' RLS policy is the same permissive
    // team_all for any authenticated session anyway, so this returns
    // identical rows to what the session-cookie client would have.
    const supabase = createServiceRoleClient();
    const { data } = await supabase.from("categories").select("*").order("sort_order");
    return (data ?? []) as Category[];
  },
  ["reference-data-categories"],
  { revalidate: REVALIDATE_SECONDS, tags: [CATEGORIES_CACHE_TAG] }
);

const getCachedProfiles = unstable_cache(
  async (): Promise<Profile[]> => {
    // Same reasoning as getCachedCategories above.
    const supabase = createServiceRoleClient();
    const { data } = await supabase.from("profiles").select("*").order("full_name");
    return (data ?? []) as Profile[];
  },
  ["reference-data-profiles"],
  { revalidate: REVALIDATE_SECONDS, tags: [PROFILES_CACHE_TAG] }
);

/** Cached categories, ordered by sort_order — same shape every existing caller already expected. */
export async function getCategories(): Promise<Category[]> {
  return getCachedCategories();
}

/** Cached team roster, ordered by full_name — same shape every existing caller already expected. */
export async function getProfiles(): Promise<Profile[]> {
  return getCachedProfiles();
}

/** Call from any route that inserts/updates/deletes a category (POST /api/categories, PATCH|DELETE /api/categories/[id]). */
export function invalidateCategoriesCache(): void {
  revalidateTag(CATEGORIES_CACHE_TAG, "max");
}

/** Call from any route that changes the team roster (PATCH /api/profiles/[id] role changes; provisioning). */
export function invalidateProfilesCache(): void {
  revalidateTag(PROFILES_CACHE_TAG, "max");
}
