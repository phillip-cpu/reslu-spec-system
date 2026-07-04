"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";

/**
 * Server action: regenerate a project's client portal token.
 *
 * Boundary note: every other write in this settings page goes through
 * the existing REST API (PUT/DELETE /api/projects/[id]) so Aria/agent
 * parity holds (BUILD-SPEC.md "Agent control — Aria": "Every UI
 * capability must therefore have an API route"). Regenerating the
 * token has no home there: app/api/projects/** is outside this
 * engineer's file boundary for this build (owned by the Estimating-
 * module work happening in parallel in the same working copy), and
 * the existing PUT handler deliberately strips `client_token` from
 * any request body (`delete body.client_token`) so it can never be
 * set that way. Rather than duplicate the route outside the boundary,
 * this action re-implements the same server-side admin check
 * (isAdmin()) inline and performs the same authenticated, RLS-scoped
 * update the route would. It is a genuine gap for Aria/API-parity —
 * flagged here and in README.md's deploy section — that should become
 * a real `POST /api/projects/[id]/regenerate-token` route (admin-only)
 * the next time this file's owner can touch app/api/projects/**.
 */
export async function regenerateProjectToken(
  projectId: string
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Unauthorized" };
  }

  const admin = await isAdmin(supabase);
  if (!admin) {
    return { ok: false, error: "Admin access required" };
  }

  const token = randomBytes(32).toString("hex");

  const { error } = await supabase
    .from("projects")
    .update({ client_token: token })
    .eq("id", projectId);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}/settings`);
  return { ok: true, token };
}
