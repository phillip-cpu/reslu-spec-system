"use client";

import type { LeadsDashboardSummary } from "@/types";
import { formatCompactValue } from "@/lib/leads";

/**
 * Pipeline dashboard strip — BUILD-SPEC.md "Pipeline dashboard: total
 * pipeline value, per-stage totals/counts, avg days in stage." Sits
 * above the board/list, below the needs-attention panel.
 */
export function PipelineDashboard({ summary }: { summary: LeadsDashboardSummary }) {
  const activeStages = summary.stages.filter((stage) => stage.included_in_pipeline);

  return (
    <div className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps !text-charcoal/50">Active pipeline value</p>
          <p className="mt-1 text-caption text-charcoal/50">
            Future nurture and closed stages are excluded.
          </p>
        </div>
        <p className="text-section font-display text-nearblack">
          {formatCompactValue(summary.total_pipeline_value)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {activeStages.map((s) => (
          <div
            key={s.stage}
            className="border border-[#c9c2b4] px-2.5 py-1.5"
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
        ))}
        <div className="border border-dashed border-[#c9c2b4] bg-nearwhite px-2.5 py-1.5">
          <p className="label-caps !text-charcoal/50">Future nurture</p>
          <p className="text-caption text-nearblack">
            {summary.future_nurture_count} {summary.future_nurture_count === 1 ? "lead" : "leads"}
            <span className="text-charcoal/50"> · not in pipeline value</span>
          </p>
        </div>
      </div>
    </div>
  );
}
