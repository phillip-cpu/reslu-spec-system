"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { regenerateProjectToken as regenerateProjectTokenShared } from "@/lib/projects";

/**
 * Server action: regenerate a project's client portal token.
 *
 * Week 6 cleanup: this used to re-implement the admin check + update
 * inline because app/api/projects/** was outside this engineer's file
 * boundary in the parallel Estimating-module build (see git history).
 * That boundary no longer applies — the shared logic now lives in
 * lib/projects.ts (regenerateProjectToken()) and is called from BOTH
 * this server action (UI stays unchanged, same call signature/behaviour
 * from the form's point of view) AND the new
 * POST /api/projects/[id]/regenerate-token route, so Aria/agent parity
 * holds (BUILD-SPEC.md "Agent control — Aria": "Every UI capability
 * must therefore have an API route") without duplicating the admin
 * check + token-generation logic in two places.
 */
export async function regenerateProjectToken(
  projectId: string
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const result = await regenerateProjectTokenShared(supabase, projectId);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/projects/${projectId}/settings`);
  return { ok: true, token: result.token };
}
