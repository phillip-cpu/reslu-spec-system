import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import type { HealthDiagnostic, PendingDiagnosticsResponse } from "@/types/health-push";

export const runtime = "nodejs";

/**
 * GET /api/health/diagnostics/pending
 *
 * Health + web push round (r26), BUILD-SPEC.md item 6 —
 * get_pending_diagnostics MCP tool wraps this route. Same team-Bearer
 * auth as the other mini-facing routes (see POST
 * /api/health/heartbeat's own comment).
 *
 * Atomically claims at most five pending rows, oldest first. The database
 * also terminally fails any claim abandoned for more than ten minutes.
 * Abandoned repairs are never replayed automatically because a runner may
 * have changed local state before it disappeared.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createServiceRoleClient();

  const { data: pending, error } = await service.rpc(
    "claim_pending_health_diagnostics",
    { p_limit: 5 }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const response: PendingDiagnosticsResponse = {
    diagnostics: (pending ?? []).map((row: HealthDiagnostic) => ({ ...row, status: "running" as const })),
  };
  return NextResponse.json(response);
}
