import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const PRUNE_DAYS = 7;

/**
 * POST /api/health/heartbeat
 *
 * Health + web push round (r26), BUILD-SPEC.md item 1/7. The mini
 * posts a row roughly every 5 minutes (docs/MINI-HEALTH-HANDOFF.md's
 * launchd heartbeat script — a plain bash+curl loop, no AI in it at
 * all, per the standing "monitoring must burn zero AI credits"
 * ruling). Team-authenticated exactly like every other MCP-facing
 * route in this schema (lib/supabase/server.ts's createClient() Bearer
 * branch — same mechanism Aria's MCP server itself uses, see
 * mcp/src/index.mjs's apiFetch and docs/ARIA.md's Authentication
 * section): the heartbeat script signs in as Aria
 * (ARIA_EMAIL/ARIA_PASSWORD, via a plain curl to Supabase Auth's own
 * REST endpoint) and sends the resulting access token as
 * `Authorization: Bearer <token>` — no separate secret/scheme
 * introduced for this route.
 *
 * Body fields are all optional (a partial/degraded heartbeat is still
 * a heartbeat — better than none): uptime, disk_free_gb, mem_free_gb,
 * openclaw_up, pending_updates, extra.
 *
 * Also prunes health_heartbeats rows older than 7 days on every
 * insert — see migration 053's own comment on why this route (rather
 * than a separate cron) owns retention: it already runs on the exact
 * cadence the retention window is measured against, so no extra cron
 * entry is needed for housekeeping this small.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    uptime?: string;
    disk_free_gb?: number;
    mem_free_gb?: number;
    openclaw_up?: boolean;
    pending_updates?: number;
    extra?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const service = createServiceRoleClient();

  const { data: inserted, error } = await service
    .from("health_heartbeats")
    .insert({
      uptime: body.uptime ?? null,
      disk_free_gb: typeof body.disk_free_gb === "number" ? body.disk_free_gb : null,
      mem_free_gb: typeof body.mem_free_gb === "number" ? body.mem_free_gb : null,
      openclaw_up: typeof body.openclaw_up === "boolean" ? body.openclaw_up : null,
      pending_updates: typeof body.pending_updates === "number" ? body.pending_updates : null,
      extra: body.extra ?? {},
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const cutoff = new Date(Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await service.from("health_heartbeats").delete().lt("created_at", cutoff);

  return NextResponse.json({ ok: true, heartbeat: inserted });
}
