import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileRole } from "@/types";

/**
 * Returns the authenticated user's role, or null if not signed in.
 * BUILD-SPEC.md §Security: Phase 1 all team members are equal EXCEPT
 * admin-only settings, which are enforced in the API (here), not via
 * "role theatre" in the UI.
 */
export async function getUserRole(
  supabase: SupabaseClient
): Promise<{ userId: string; role: ProfileRole } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  return { userId: user.id, role: (profile?.role as ProfileRole) ?? "designer" };
}

export async function isAdmin(supabase: SupabaseClient): Promise<boolean> {
  const info = await getUserRole(supabase);
  return info?.role === "admin";
}
