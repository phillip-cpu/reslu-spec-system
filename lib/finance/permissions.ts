import type { SupabaseClient } from "@supabase/supabase-js";
import type { FinanceCapability } from "../../types/finance";

export interface FinancePermissionResult {
  allowed: boolean;
  error: string | null;
}

/**
 * Database-enforced capability check. There is intentionally no role
 * fallback here: until migration 080 has seeded explicit admin grants,
 * finance routes stay unavailable rather than reverting to API-only
 * role checks.
 */
export async function hasFinanceCapability(
  supabase: SupabaseClient,
  capability: FinanceCapability,
  projectId: string | null = null
): Promise<FinancePermissionResult> {
  const { data, error } = await supabase.rpc("has_finance_capability", {
    p_capability: capability,
    p_project_id: projectId,
  });

  if (error) {
    return { allowed: false, error: error.message };
  }
  return { allowed: data === true, error: null };
}
