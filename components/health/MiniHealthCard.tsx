"use client";

import { useEffect, useState } from "react";
import { HealthPill } from "@/components/health/HealthPill";
import { heartbeatAgeLevel } from "@/lib/health-status";
import { DiagnosticsButton } from "@/components/health/DiagnosticsButton";
import type { HealthHeartbeat, HealthDiagnostic } from "@/types/health-push";

interface Props {
  heartbeat: HealthHeartbeat | null;
  latestDiagnostic: HealthDiagnostic | null;
}

function formatAge(minutes: number): string {
  if (!Number.isFinite(minutes)) return "never";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Health + web push round (r26), BUILD-SPEC.md item 4: "mini card
 * (heartbeat age pill, uptime/disk/mem, pending macOS updates warning,
 * 'Run diagnostics & repair' button ...)." Client component only for
 * the "client-side ticking ok" heartbeat age (item 4's own wording) —
 * the age re-renders every 30s off the SAME server-fetched
 * `heartbeat.created_at`, no polling/re-fetch involved, just a local
 * clock tick recomputing elapsed time.
 */
export function MiniHealthCard({ heartbeat, latestDiagnostic }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const ageMinutes = heartbeat ? (Date.now() - new Date(heartbeat.created_at).getTime()) / 60_000 : Infinity;
  const level = heartbeatAgeLevel(ageMinutes);
  const pendingUpdates = heartbeat?.pending_updates ?? 0;

  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-subhead text-nearblack">Mini (Aria's Mac mini)</h3>
        <HealthPill level={level} label={`Heartbeat: ${formatAge(ageMinutes)}`} />
      </div>

      {heartbeat ? (
        <dl className="grid grid-cols-2 gap-3 text-body sm:grid-cols-4">
          <div>
            <dt className="label-caps text-charcoal/50">Uptime</dt>
            <dd className="text-charcoal">{heartbeat.uptime ?? "—"}</dd>
          </div>
          <div>
            <dt className="label-caps text-charcoal/50">Disk free</dt>
            <dd className="text-charcoal">{heartbeat.disk_free_gb != null ? `${heartbeat.disk_free_gb} GB` : "—"}</dd>
          </div>
          <div>
            <dt className="label-caps text-charcoal/50">Mem free</dt>
            <dd className="text-charcoal">{heartbeat.mem_free_gb != null ? `${heartbeat.mem_free_gb} GB` : "—"}</dd>
          </div>
          <div>
            <dt className="label-caps text-charcoal/50">OpenClaw</dt>
            <dd className="text-charcoal">
              {heartbeat.openclaw_up === null ? "—" : heartbeat.openclaw_up ? "Up" : "Down"}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-body text-charcoal/60">No heartbeat has ever been received from the mini.</p>
      )}

      {pendingUpdates > 0 && (
        <p className="mt-4 border border-[#C9971E] bg-[#F3E4C6] px-3 py-2 text-caption text-[#8A6208]">
          macOS update pending — WhatsApp bridge may drop after reboot.
        </p>
      )}

      <div className="mt-5 border-t border-[#dcd6cc] pt-4">
        <DiagnosticsButton latestDiagnostic={latestDiagnostic} />
      </div>
    </div>
  );
}
