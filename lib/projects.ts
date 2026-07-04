import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { isAdmin } from "@/lib/auth";

/**
 * Regenerates a project's client portal token (projects.client_token).
 * Admin-only — checked here so every caller (the settings server
 * action AND the REST route) gets the same enforcement rather than
 * re-implementing it twice, which is what caused the Aria/API-parity
 * gap this function closes (see app/(dashboard)/projects/[id]/settings/actions.ts
 * and app/api/projects/[id]/regenerate-token/route.ts, both of which
 * now just call this).
 *
 * BUILD-SPEC.md "Agent control — Aria": "Every UI capability must
 * therefore have an API route" — this was the one settings action that
 * had no REST equivalent; Week 6 cleanup item.
 */
export async function regenerateProjectToken(
  supabase: SupabaseClient,
  projectId: string
): Promise<{ ok: true; token: string } | { ok: false; error: string; status: number }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Unauthorized", status: 401 };
  }

  const admin = await isAdmin(supabase);
  if (!admin) {
    return { ok: false, error: "Admin access required", status: 403 };
  }

  const token = randomBytes(32).toString("hex");

  const { error } = await supabase
    .from("projects")
    .update({ client_token: token })
    .eq("id", projectId);

  if (error) {
    return { ok: false, error: error.message, status: 500 };
  }

  return { ok: true, token };
}
