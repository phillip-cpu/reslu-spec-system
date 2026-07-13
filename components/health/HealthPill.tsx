import { healthPillTint } from "@/lib/health-status";
import type { HealthPillLevel } from "@/types/health-push";

/**
 * Health + web push round (r26) — the one shared pill component every
 * Health page card uses (mini card heartbeat status, channel status,
 * Spec card cron statuses). Same "border + tinted background + darker
 * text" pill shape as components/projects/StatusPill.tsx and
 * lib/board-constants.ts's status pills, sharp corners (no explicit
 * rounded-* class needed — tailwind.config.ts forces borderRadius to
 * 0px globally), but reads its colours from lib/health-status.ts
 * (deliberately NOT board-constants.ts — see that file's own header
 * comment for why).
 */
export function HealthPill({ level, label }: { level: HealthPillLevel; label: string }) {
  const tint = healthPillTint(level);
  return (
    <span
      className="label-caps inline-block border px-2 py-1"
      style={{ backgroundColor: tint.background, color: tint.text, borderColor: tint.border }}
    >
      {label}
    </span>
  );
}
