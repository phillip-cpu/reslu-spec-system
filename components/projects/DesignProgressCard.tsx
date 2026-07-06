"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { DesignFrameworkResponse, DesignPhaseStatus } from "@/types/phase-12b";

interface Props {
  projectId: string;
}

const STATUS_DOT_CLASS: Record<DesignPhaseStatus, string> = {
  not_started: "bg-charcoal/20",
  in_progress: "bg-sand",
  complete: "bg-nearblack",
  na: "border border-charcoal/30 bg-transparent",
};

/**
 * Overview card — BUILD-SPEC.md §"12b Design Framework": "completion
 * rolling into overview traffic lights." This task's brief: "Design
 * progress card on the project Overview (additive component, safe
 * mount like PlanCheckCard did): 7 phases as compact status dots +
 * label, links to Design tab."
 *
 * Self-contained: fetches its own summary from
 * GET /api/projects/[id]/design (the same route the Design tab itself
 * uses — this card is a read-only, lighter-weight consumer of the same
 * payload) so it can be dropped into ProjectOverview.tsx's card grid as
 * a pure additive slot, mirroring PlanCheckCard.tsx's own "self-
 * contained fetch, safe mount" shape exactly. Unlike PlanCheckCard,
 * this card always renders once loaded (a project always has its 7
 * design phases, seeded on first fetch by the API itself — there is no
 * "nothing to show yet" empty state to suppress).
 */
export function DesignProgressCard({ projectId }: Props) {
  const [data, setData] = useState<DesignFrameworkResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/design`)
      .then((r) => r.json())
      .then((body) => {
        if (active) setData(body as DesignFrameworkResponse);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId]);

  if (loading || !data) return null;

  const completeCount = data.phases.filter((p) => p.status === "complete" || p.status === "na").length;

  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-5">
      <p className="label-caps mb-3">Design</p>
      <p className="font-display text-section text-nearblack">
        {completeCount}/{data.phases.length}
      </p>
      <p className="text-caption text-charcoal/50">Phases complete</p>
      <ul className="mt-4 space-y-1.5">
        {data.phases.map((phase) => (
          <li key={phase.id} className="flex items-center gap-2">
            <span className={clsx("h-2 w-2 shrink-0 rounded-full", STATUS_DOT_CLASS[phase.status])} />
            <span className="text-caption text-charcoal/70">{phase.name}</span>
          </li>
        ))}
      </ul>
      <a
        href={`/projects/${projectId}/design`}
        className="mt-4 inline-block text-caption text-sand underline decoration-sand/40 underline-offset-2 hover:decoration-sand"
      >
        Open Design tab
      </a>
    </div>
  );
}
