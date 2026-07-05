"use client";

import { useEffect, useState } from "react";
import type { PlanAnalysisSummaryResponse } from "@/types/phase-12a-a";

interface Props {
  projectId: string;
}

/**
 * Overview card — BUILD-SPEC.md "SOW completion + Aria plan analysis":
 * "Discrepancy report surfaces in project overview + needs-attention
 * ('Plans T3 reference SS-01/SS-02 — register has ST-01/ST-02')."
 *
 * Self-contained: fetches its own summary from
 * GET /api/projects/[id]/plan-analysis so it can be dropped into
 * ProjectOverview.tsx's card grid as a pure additive slot, with no
 * change to that component's existing data flow (mirrors how
 * DocumentStatusLight and every other overview card sub-widget already
 * fetches/patches independently). Renders nothing (returns null) once
 * loaded if no analysis has ever been run yet — a project with no
 * plans uploaded, or plans not yet analysed, shouldn't show an empty/
 * placeholder card cluttering the grid; the "no analysis yet" hint
 * lives on the plans upload surface itself, not here.
 */
export function PlanCheckCard({ projectId }: Props) {
  const [data, setData] = useState<PlanAnalysisSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/plan-analysis`)
      .then((r) => r.json())
      .then((body) => {
        if (active) setData(body as PlanAnalysisSummaryResponse);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId]);

  if (loading || !data?.latest) return null;

  const { latest } = data;
  const count = latest.discrepancies.length;

  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-5">
      <p className="label-caps mb-3">Plan Check</p>
      <p className="font-display text-section text-nearblack">
        {count === 0 ? "All clear" : `${count} discrepanc${count === 1 ? "y" : "ies"}`}
      </p>
      <p className="mt-1 text-caption text-charcoal/50">
        {latest.revision_label ? `${latest.revision_label} — ` : ""}
        analysed {new Date(latest.analysed_at).toLocaleDateString("en-AU")}
        {latest.analysed_by ? ` by ${latest.analysed_by}` : ""}
      </p>
      {count > 0 && (
        <ul className="mt-4 space-y-2">
          {latest.discrepancies.slice(0, 3).map((d, i) => (
            <li key={i} className="text-body text-charcoal">
              {d.message}
            </li>
          ))}
          {count > 3 && (
            <li className="text-caption text-charcoal/40">+ {count - 3} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
