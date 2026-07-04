"use client";

import clsx from "clsx";
import type { LeadsDashboardSummary } from "@/types";
import { INACTIVE_LEAD_STAGES } from "@/types";
import { formatCompactValue } from "@/lib/leads";

/**
 * Pipeline dashboard strip — BUILD-SPEC.md "Pipeline dashboard: total
 * pipeline value, per-stage totals/counts, avg days in stage." Sits
 * above the board/list, below the needs-attention panel.
 */
export function PipelineDashboard({ summary }: { summary: LeadsDashboardSummary }) {
  return (
    <div className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex items-baseline justify-between">
        <p className="label-caps !text-charcoal/50">Total pipeline value</p>
        <p className="text-section font-display text-nearblack">
          {formatCompactValue(summary.total_pipeline_value)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {summary.stages.map((s) => {
          const muted = INACTIVE_LEAD_STAGES.includes(s.stage);
          return (
            <div
              key={s.stage}
              className={clsx(
                "border px-2.5 py-1.5",
                muted ? "border-[#e5e0d6] opacity-60" : "border-[#c9c2b4]"
              )}
              title={
                s.avg_days_in_stage !== null
                  ? `Avg ${s.avg_days_in_stage} days in stage`
                  : "No history yet"
              }
            >
              <p className="label-caps !text-charcoal/50">{s.stage}</p>
              <p className="text-caption text-nearblack">
                {s.count} · {formatCompactValue(s.value)}
                {s.avg_days_in_stage !== null && (
                  <span className="text-charcoal/50"> · {s.avg_days_in_stage}d avg</span>
                )}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
