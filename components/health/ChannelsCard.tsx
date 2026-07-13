import { HealthPill } from "@/components/health/HealthPill";
import { channelPillLevel } from "@/lib/health-status";
import type { HealthChannel } from "@/types/health-push";

/**
 * Health + web push round (r26), BUILD-SPEC.md item 4: "channels list
 * (per group chat: status, last in/out, session pill)." Plain server-
 * rendered list — no interactivity, so no "use client" needed (mirrors
 * this codebase's other read-only admin list sections, e.g.
 * components/settings/SystemHealth.tsx).
 */
export function ChannelsCard({ channels }: { channels: HealthChannel[] }) {
  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-6">
      <h3 className="mb-4 text-subhead text-nearblack">Channels</h3>
      {channels.length === 0 ? (
        <p className="text-body text-charcoal/60">No channels reported yet.</p>
      ) : (
        <div className="divide-y divide-[#dcd6cc]">
          {channels.map((ch) => (
            <div key={ch.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <p className="text-body text-nearblack">{ch.label ?? ch.channel}</p>
                <p className="text-caption text-charcoal/50">
                  in: {ch.last_inbound_at ? new Date(ch.last_inbound_at).toLocaleString("en-AU") : "—"} · out:{" "}
                  {ch.last_outbound_at ? new Date(ch.last_outbound_at).toLocaleString("en-AU") : "—"}
                </p>
                {ch.note && <p className="text-caption text-charcoal/50">{ch.note}</p>}
              </div>
              <div className="flex items-center gap-2">
                {ch.session_valid === false && <HealthPill level="amber" label="Session invalid" />}
                <HealthPill level={channelPillLevel(ch.status, ch.session_valid)} label={ch.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
