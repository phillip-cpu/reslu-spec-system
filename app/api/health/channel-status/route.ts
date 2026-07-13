import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { notifyAdminsOnce, resolveOpenIncident } from "@/lib/push";

export const runtime = "nodejs";

/**
 * POST /api/health/channel-status
 *
 * Health + web push round (r26), BUILD-SPEC.md item 1/6. The mini
 * (OpenClaw) reports the health of one monitored channel — WhatsApp
 * group bridge, email, RESLU calendar — upserted by `channel` (the
 * stable machine key). Same team-Bearer auth as POST
 * /api/health/heartbeat (see that route's own comment) — the
 * report_channel_status MCP tool is a thin wrapper over this route
 * (mcp/src/index.mjs).
 *
 * Incident push: a transition INTO status='degraded'/'down' or
 * session_valid=false fires a deduped incident notification
 * (lib/push.ts's notifyAdminsOnce, kind `channel_down:{channel}`) —
 * "one alert per incident, not per check" (item 5). A transition BACK
 * to ok (and session_valid true/omitted) resolves any open incident of
 * that kind (resolveOpenIncident) so the NEXT bad transition fires a
 * fresh alert instead of staying silently deduped forever.
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
    channel?: string;
    label?: string;
    status?: "ok" | "degraded" | "down";
    last_inbound_at?: string;
    last_outbound_at?: string;
    session_valid?: boolean;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.channel || !body.status || !["ok", "degraded", "down"].includes(body.status)) {
    return NextResponse.json(
      { error: "channel and status ('ok'|'degraded'|'down') are required." },
      { status: 400 }
    );
  }

  const service = createServiceRoleClient();

  const { data: updated, error } = await service
    .from("health_channels")
    .upsert(
      {
        channel: body.channel,
        label: body.label ?? null,
        status: body.status,
        last_inbound_at: body.last_inbound_at ?? null,
        last_outbound_at: body.last_outbound_at ?? null,
        session_valid: typeof body.session_valid === "boolean" ? body.session_valid : null,
        note: body.note ?? null,
      },
      { onConflict: "channel" }
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const incidentKind = `channel_down:${body.channel}`;
  const isIncident = body.status !== "ok" || body.session_valid === false;

  if (isIncident) {
    const label = body.label ?? body.channel;
    await notifyAdminsOnce(
      incidentKind,
      `Channel ${body.status === "ok" ? "session issue" : body.status} — ${label}`,
      body.note ?? `Reported by the mini: status=${body.status}, session_valid=${String(body.session_valid ?? "n/a")}.`,
      "/health"
    );
  } else {
    await resolveOpenIncident(incidentKind);
  }

  return NextResponse.json({ ok: true, channel: updated });
}
