import { HealthPill } from "@/components/health/HealthPill";
import type { SpecHealthSummary } from "@/types/health-push";

/**
 * Health + web push round (r26), BUILD-SPEC.md item 4: "Spec card
 * (monitored job runs, failed email sends, aria_queue stuck >24h,
 * needs_aria backlog count). See lib/health.ts's computeSpecHealth.
 */
export function SpecHealthCard({ summary }: { summary: SpecHealthSummary }) {
  const conversations = summary.conversation_transport;
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

      <div className="mt-6 border-t border-[#dcd6cc] pt-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-body font-semibold text-nearblack">Aria &amp; Marco conversations</h4>
            <p className="mt-1 text-caption text-charcoal/50">Queue, durable-task, active-call and content-free voice timing diagnostics.</p>
          </div>
          <HealthPill
            level={conversations.level}
            label={conversations.level === "green" ? "Healthy" : conversations.level === "amber" ? "Latency warning" : "Needs attention"}
          />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-body sm:grid-cols-4">
          <div><dt className="label-caps text-charcoal/50">Queued chat turns</dt><dd className="text-charcoal">{conversations.pending_jobs}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Stuck chat turns</dt><dd className="text-charcoal">{conversations.processing_jobs_stuck}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Failed turns (24h)</dt><dd className="text-charcoal">{conversations.failed_jobs_24h}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Queued agent tasks</dt><dd className="text-charcoal">{conversations.queued_tasks}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Stuck agent tasks</dt><dd className="text-charcoal">{conversations.running_tasks_stuck}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Failed tasks (24h)</dt><dd className="text-charcoal">{conversations.failed_tasks_24h}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Stale active calls</dt><dd className="text-charcoal">{conversations.active_calls_stale}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Health read errors</dt><dd className="text-charcoal">{conversations.query_errors}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Voice samples</dt><dd className="text-charcoal">{conversations.voice_turns_observed} turns / {conversations.voice_calls_observed} calls</dd></div>
          <div><dt className="label-caps text-charcoal/50">Average acknowledgement</dt><dd className="text-charcoal">{conversations.average_acknowledgement_ms == null ? "No sample" : `${conversations.average_acknowledgement_ms} ms`}</dd></div>
          <div><dt className="label-caps text-charcoal/50">Slowest interruption clear</dt><dd className="text-charcoal">{conversations.slowest_interruption_clear_ms == null ? "No sample" : `${conversations.slowest_interruption_clear_ms} ms`}</dd></div>
        </dl>
        <p className="mt-3 text-caption text-charcoal/45">Targets: acknowledgement ≤1,000 ms and audible-output clear ≤250 ms. No transcript, prompt, file, tool argument or provider identifier is read for this card.</p>
      </div>
    </div>
  );
}
