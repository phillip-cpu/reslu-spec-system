import { HealthPill } from "@/components/health/HealthPill";
import type { SpecHealthSummary } from "@/types/health-push";

/**
 * Health + web push round (r26), BUILD-SPEC.md item 4: "Spec card
 * (monitored job runs, failed email sends, aria_queue stuck >24h,
 * needs_aria backlog count). See lib/health.ts's computeSpecHealth.
 */
export function SpecHealthCard({ summary }: { summary: SpecHealthSummary }) {
  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-6">
      <h3 className="mb-4 text-subhead text-nearblack">Spec system</h3>

      <div className="space-y-2">
        {summary.crons.map((cron) => (
          <div key={cron.key} className="flex items-start justify-between gap-2">
            <div>
              <span className="text-body text-charcoal">{cron.label}</span>
              {cron.last_error ? (
                <p className="mt-0.5 max-w-md text-caption text-[#7A1F1F]">{cron.last_error}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-caption text-charcoal/50">
                {cron.last_run_at ? new Date(cron.last_run_at).toLocaleString("en-AU") : "never"}
              </span>
              <HealthPill
                level={cron.level}
                label={
                  cron.last_status === "failed"
                    ? "Failed"
                    : cron.last_status === "degraded"
                      ? "Warning"
                      : cron.level === "green"
                        ? "OK"
                        : cron.level === "amber"
                          ? "Late"
                          : "Missed"
                }
              />
            </div>
          </div>
        ))}
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-[#dcd6cc] pt-4 text-body">
        <div>
          <dt className="label-caps text-charcoal/50">Failed sends (7d)</dt>
          <dd className="text-charcoal">{summary.failed_email_sends_7d}</dd>
        </div>
        <div>
          <dt className="label-caps text-charcoal/50">Aria queue stuck &gt;24h</dt>
          <dd className="text-charcoal">{summary.aria_queue_stuck}</dd>
        </div>
        <div>
          <dt className="label-caps text-charcoal/50">Needs-Aria backlog</dt>
          <dd className="text-charcoal">{summary.needs_aria_backlog}</dd>
        </div>
      </dl>
    </div>
  );
}
