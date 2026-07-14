import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { notifyAdminsOnce, resolveOpenIncident } from "@/lib/push";
import {
  computeSpecHealth,
  minutesSince,
  MINI_SILENCE_INCIDENT_MINUTES,
  CHANNEL_SILENCE_INCIDENT_HOURS,
} from "@/lib/health";

export const runtime = "nodejs";

/**
 * GET /api/health/check — Vercel Cron entry point.
 *
 * Health + web push round (r26), BUILD-SPEC.md item 5: "compares
 * timestamps -> fires push/notifications (dedupe: one alert per
 * incident, not per check)." Pure timestamp comparisons against
 * already-recorded rows — no AI call anywhere in this route, per the
 * standing "monitoring must burn zero AI credits" ruling. vercel.json
 * is PROTECTED (Claude Code owns it) — the cron line to add is
 * documented in docs/MINI-HEALTH-HANDOFF.md: every 10 minutes,
 * `"*\/10 * * * *"`.
 *
 * Auth mirrors every other cron in this build (see e.g.
 * app/api/second-brain/triage/route.ts): Bearer CRON_SECRET or an
 * authenticated team session (the latter lets an admin trigger a
 * manual check from a browser tab before the cron line is wired up).
 *
 * Three independent checks, each individually deduped by kind (see
 * lib/push.ts's notifyAdminsOnce/resolveOpenIncident):
 *   1. Mini heartbeat silence (>15min since the latest
 *      health_heartbeats row, or none ever) -> kind 'mini_silent'.
 *      Also: the latest heartbeat's own openclaw_up=false -> kind
 *      'openclaw_down' (independent of silence — the mini can be
 *      posting heartbeats fine while its own OpenClaw process is
 *      down).
 *   2. Each health_channels row gone silent (last_inbound_at/
 *      last_outbound_at both older than 24h, or never set) -> kind
 *      `channel_down:{channel}`. Complementary to the explicit-status
 *      push POST /api/health/channel-status already fires on
 *      ingestion — this catches the case where the mini stops
 *      reporting a channel's status AT ALL (e.g. OpenClaw crashed
 *      before it ever got to report 'down' itself).
 *   3. Derivable cron last-success gone stale (lib/health.ts's own
 *      "where derivable" scope — see that file's header comment) ->
 *      kind `cron_missed:{key}`.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const service = createServiceRoleClient();
  const incidents: string[] = [];
  const resolved: string[] = [];

  // ---- 1. Mini heartbeat silence + openclaw_up ----
  const { data: latestHeartbeat } = await service
    .from("health_heartbeats")
    .select("created_at,openclaw_up")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const heartbeatAgeMinutes = minutesSince(latestHeartbeat?.created_at ?? null);
  if (heartbeatAgeMinutes > MINI_SILENCE_INCIDENT_MINUTES) {
    const { deduped } = await notifyAdminsOnce(
      "mini_silent",
      "Mini silent",
      latestHeartbeat
        ? `No heartbeat in over ${MINI_SILENCE_INCIDENT_MINUTES} minutes (last seen ${latestHeartbeat.created_at}).`
        : "No heartbeat has ever been received from the mini.",
      "/health"
    );
    if (!deduped) incidents.push("mini_silent");
  } else {
    await resolveOpenIncident("mini_silent");
    resolved.push("mini_silent");
  }

  if (latestHeartbeat && latestHeartbeat.openclaw_up === false) {
    const { deduped } = await notifyAdminsOnce(
      "openclaw_down",
      "OpenClaw process down",
      "The mini's latest heartbeat reports openclaw_up=false.",
      "/health"
    );
    if (!deduped) incidents.push("openclaw_down");
  } else if (latestHeartbeat && latestHeartbeat.openclaw_up === true) {
    await resolveOpenIncident("openclaw_down");
    resolved.push("openclaw_down");
  }

  // ---- 2. Channel silence ----
  const { data: channels } = await service
    .from("health_channels")
    .select("channel,label,last_inbound_at,last_outbound_at");

  for (const ch of channels ?? []) {
    const lastActivity = [ch.last_inbound_at, ch.last_outbound_at]
      .filter((v): v is string => !!v)
      .sort()
      .pop();
    const ageHours = lastActivity ? minutesSince(lastActivity) / 60 : Infinity;
    const kind = `channel_down:${ch.channel}`;
    if (ageHours > CHANNEL_SILENCE_INCIDENT_HOURS) {
      const { deduped } = await notifyAdminsOnce(
        kind,
        `Channel silent — ${ch.label ?? ch.channel}`,
        lastActivity
          ? `No inbound/outbound activity reported in over ${CHANNEL_SILENCE_INCIDENT_HOURS}h (last: ${lastActivity}).`
          : "No inbound/outbound activity has ever been reported for this channel.",
        "/health"
      );
      if (!deduped) incidents.push(kind);
    } else {
      await resolveOpenIncident(kind);
      resolved.push(kind);
    }
  }

  // ---- 3. Monitored scheduled-job health ----
  // Reuses lib/health.ts's computeSpecHealth (also used by the Health
  // page itself) rather than re-deriving cron last-success separately —
  // it fetches a couple of extra counts (aria_queue/materials) this
  // route doesn't otherwise need, but that's a cheap couple of extra
  // reads on a 10-minute cron, not worth a second code path to avoid.
  const specHealth = await computeSpecHealth(service);
  for (const cron of specHealth.crons) {
    const kind = `cron_missed:${cron.key}`;
    const degradedKind = `cron_degraded:${cron.key}`;
    if (cron.last_status === "degraded") {
      const { deduped } = await notifyAdminsOnce(
        degradedKind,
        `Scheduled job needs attention — ${cron.label}`,
        [cron.last_error, cron.last_run_at ? `Run: ${cron.last_run_at}.` : null]
          .filter(Boolean)
          .join(" ") || "The latest run completed with one or more partial failures.",
        "/health"
      );
      if (!deduped) incidents.push(degradedKind);
      await resolveOpenIncident(kind);
      resolved.push(kind);
    } else {
      await resolveOpenIncident(degradedKind);
      resolved.push(degradedKind);
    }

    if (cron.level === "red") {
      const { deduped } = await notifyAdminsOnce(
        kind,
        cron.last_status === "failed"
          ? `Scheduled job failed — ${cron.label}`
          : `Scheduled job missed — ${cron.label}`,
        cron.last_status === "failed"
          ? [cron.last_error, cron.last_run_at ? `Run: ${cron.last_run_at}.` : null]
              .filter(Boolean)
              .join(" ") || "The latest run failed."
          : cron.last_success_at
            ? `Last success was ${cron.last_success_at}.`
            : "No successful run has ever been recorded.",
        "/health"
      );
      if (!deduped) incidents.push(kind);
    } else if (cron.level === "green") {
      await resolveOpenIncident(kind);
      resolved.push(kind);
    }
  }

  return NextResponse.json({ ok: true, incidents, resolved });
}
