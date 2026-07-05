"use client";

import { useEffect, useState } from "react";
import { DocumentStatusLight } from "./DocumentStatusLight";
import { PlanCheckCard } from "./PlanCheckCard";
import type { DocumentStatus, ProjectFileKind, ProjectOverviewResponse } from "@/types";

interface Props {
  projectId: string;
  isAdmin: boolean;
}

const DOC_KIND_LABEL: Record<ProjectFileKind, string> = {
  plans: "Plans",
  council: "Council",
  engineering: "Engineering",
  scope_of_works: "Scope of Works",
  other: "Other",
};

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString("en-AU");
}

const ACTION_LABEL: Record<string, string> = {
  approve: "approved",
  flag: "flagged",
  revise: "requested a revision on",
};

/**
 * The Overview tab — BUILD-SPEC.md "Project overview hub": FF&E,
 * Documents (traffic lights), Estimate summary (admin only), and
 * Client activity cards. Fetches its own data from
 * GET /api/projects/[id]/overview rather than the server page passing
 * it down, so the traffic-light click-to-cycle interaction can update
 * this card's local state without re-fetching the whole page.
 */
export function ProjectOverview({ projectId, isAdmin }: Props) {
  const [data, setData] = useState<ProjectOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/overview`)
      .then((r) => r.json())
      .then((body) => {
        if (!active) return;
        if (body.error) throw new Error(body.error);
        setData(body as ProjectOverviewResponse);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "Could not load overview."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId]);

  function setDocStatus(kind: ProjectFileKind, status: DocumentStatus) {
    setData((cur) =>
      cur
        ? {
            ...cur,
            documents: cur.documents.map((d) => (d.kind === kind ? { ...d, status } : d)),
          }
        : cur
    );
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Loading overview…</p>;
  }
  if (error || !data) {
    return <p className="text-body text-red-700">{error ?? "Could not load overview."}</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
      {/* FF&E card */}
      <Card title="FF&E">
        <BigStat value={data.ffe.item_count} label="Items" />
        <div className="mt-4 space-y-1.5">
          <StatRow label="Approved" value={data.ffe.approved_count} />
          <StatRow label="Flagged" value={data.ffe.flagged_count} />
          <StatRow label="Ordered+" value={data.ffe.ordered_count} />
        </div>
        <a
          href={`/projects/${projectId}?tab=ffe`}
          className="mt-4 inline-block text-caption text-sand underline decoration-sand/40 underline-offset-2 hover:decoration-sand"
        >
          Open FF&E schedule
        </a>
      </Card>

      {/* Documents card */}
      <Card title="Documents">
        <div className="space-y-2.5">
          {data.documents.map((doc) => (
            <div key={doc.kind} className="flex items-center justify-between gap-2">
              <div>
                <p className="text-body text-nearblack">{DOC_KIND_LABEL[doc.kind]}</p>
                {doc.latest_revision_label && (
                  <p className="text-caption text-charcoal/40">{doc.latest_revision_label}</p>
                )}
              </div>
              <DocumentStatusLight
                projectId={projectId}
                kind={doc.kind}
                status={doc.status}
                onChanged={(next) => setDocStatus(doc.kind, next)}
                size="compact"
              />
            </div>
          ))}
        </div>
        <a
          href={`/projects/${projectId}/documents`}
          className="mt-4 inline-block text-caption text-sand underline decoration-sand/40 underline-offset-2 hover:decoration-sand"
        >
          Open documents
        </a>
      </Card>

      {/* Estimate card — admin only, financial data */}
      {isAdmin && data.estimate && (
        <Card title="Estimate">
          <BigStat value={formatMoney(data.estimate.total_inc_gst)} label="Total inc GST" />
          <div className="mt-4 space-y-1.5">
            <StatRow label="Quoted" value={`${data.estimate.percent_quoted}%`} />
            <StatRow
              label="Variance"
              value={data.estimate.variance !== null ? formatMoney(data.estimate.variance) : "—"}
            />
          </div>
          <a
            href={`/projects/${projectId}/estimate`}
            className="mt-4 inline-block text-caption text-sand underline decoration-sand/40 underline-offset-2 hover:decoration-sand"
          >
            Open estimate
          </a>
        </Card>
      )}
      {isAdmin && !data.estimate && (
        <Card title="Estimate">
          <p className="text-body text-charcoal/40">Not initialised yet.</p>
          <a
            href={`/projects/${projectId}/estimate`}
            className="mt-4 inline-block text-caption text-sand underline decoration-sand/40 underline-offset-2 hover:decoration-sand"
          >
            Set up estimate
          </a>
        </Card>
      )}

      {/* Client activity card */}
      <Card title="Client activity">
        {data.client_activity.length === 0 ? (
          <p className="text-body text-charcoal/40">No client activity yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {data.client_activity.map((ev) => (
              <li key={ev.id} className="text-body text-charcoal">
                <span className="text-nearblack">{ev.item_code ?? "Item"}</span>{" "}
                {ACTION_LABEL[ev.action] ?? ev.action}
                {ev.note ? <span className="text-charcoal/50"> — “{ev.note}”</span> : null}
                <p className="text-caption text-charcoal/40">{relativeTime(ev.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Plan Check card (Phase 12a-A, additive) — self-contained,
          renders nothing until a plan analysis has been run at least
          once for this project. See components/projects/PlanCheckCard.tsx. */}
      <PlanCheckCard projectId={projectId} />
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-5">
      <p className="label-caps mb-3">{title}</p>
      {children}
    </div>
  );
}

function BigStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <p className="font-display text-section text-nearblack">{value}</p>
      <p className="text-caption text-charcoal/50">{label}</p>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-caption text-charcoal/50">{label}</span>
      <span className="text-body text-nearblack">{value}</span>
    </div>
  );
}
