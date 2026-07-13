import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import type { PendingDiagnosticsResponse } from "@/types/health-push";

export const runtime = "nodejs";

/**
 * GET /api/health/diagnostics/pending
 *
 * Health + web push round (r26), BUILD-SPEC.md item 6 —
 * get_pending_diagnostics MCP tool wraps this route. Same team-Bearer
 * auth as the other mini-facing routes (see POST
 * /api/health/heartbeat's own comment).
 *
 * Returns every 'pending' row, oldest-requested first, and atomically
 * flips them to 'running' as it returns them — this is the "claim"
 * step (health_diagnostics.status supports pending|running|done|failed
 * per migration 053): a second poll a few seconds later (the mini's
 * own loop, docs/MINI-HEALTH-HANDOFF.md) won't pick the same row up
 * again and double-run repairs on it. There is exactly one mini in
 * this system, so no cross-worker race is expected in practice — the
 * status transition exists for correctness/auditability regardless.
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

  const { data: pending, error } = await service
    .from("health_diagnostics")
    .select("*")
    .eq("status", "pending")
    .order("requested_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = pending ?? [];
  if (rows.length > 0) {
    await service
      .from("health_diagnostics")
      .update({ status: "running" })
      .in(
        "id",
        rows.map((r) => r.id)
      );
  }

  const response: PendingDiagnosticsResponse = {
    diagnostics: rows.map((r) => ({ ...r, status: "running" })),
  };
  return NextResponse.json(response);
}
