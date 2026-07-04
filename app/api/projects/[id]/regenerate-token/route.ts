import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { regenerateProjectToken } from "@/lib/projects";

export const runtime = "nodejs";

/**
 * POST /api/projects/[id]/regenerate-token
 * Admin-only. REST equivalent of the settings page's
 * regenerateProjectToken() server action — both now call the same
 * shared lib/projects.ts helper, so this route and the UI can never
 * drift on the admin check or how the token is generated. Closes the
 * Aria/API-parity gap flagged in
 * app/(dashboard)/projects/[id]/settings/actions.ts (BUILD-SPEC.md
 * "Agent control — Aria": "Every UI capability must therefore have an
 * API route").
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const result = await regenerateProjectToken(supabase, projectId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ token: result.token });
}
