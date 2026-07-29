"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  DataQualitySeverity,
  ProjectDataQualityIssue,
  ProjectDataQualityResponse,
} from "@/types/data-quality";

const SEVERITY_LABEL: Record<DataQualitySeverity, string> = {
  critical: "Critical",
  warning: "Needs attention",
  info: "Information",
};

const SEVERITY_CLASS: Record<DataQualitySeverity, string> = {
  critical: "border-red-700/30 bg-red-50 text-red-800",
  warning: "border-amber-700/30 bg-amber-50 text-amber-900",
  info: "border-[#c9c2b4] bg-nearwhite text-charcoal",
};

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(value);
}

function IssueRow({
  issue,
  busy,
  onDismiss,
}: {
  issue: ProjectDataQualityIssue;
  busy: boolean;
  onDismiss: () => void;
}) {
  const dismissible = issue.area === "register" || issue.area === "pricing";

  return (
    <li className="border-t border-[#e5e0d6] py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`border px-2 py-0.5 text-caption ${SEVERITY_CLASS[issue.severity]}`}
            >
              {SEVERITY_LABEL[issue.severity]}
            </span>
            <p className="text-body font-medium text-nearblack">
              {issue.title} · {issue.count}
            </p>
          </div>
          <p className="mt-1 text-caption text-charcoal/60">{issue.detail}</p>
          {issue.samples.length > 0 && (
            <p className="mt-1 truncate text-caption text-charcoal/45">
              {issue.samples.map((sample) => sample.label).join(" · ")}
              {issue.count > issue.samples.length ? ` · +${issue.count - issue.samples.length} more` : ""}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <a
            href={issue.href}
            className="text-caption text-sand underline decoration-sand/40 underline-offset-2 hover:decoration-sand"
          >
            Review
          </a>
          {dismissible && (
            <button
              type="button"
              disabled={busy}
              onClick={onDismiss}
              title="Hide this issue until its affected records change"
              className="text-caption text-charcoal/45 underline decoration-charcoal/20 underline-offset-2 hover:text-nearblack disabled:opacity-40"
            >
              {busy ? "Dismissing…" : "Dismiss"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function ProjectDataQualityPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectDataQualityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/data-quality`, {
      cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error ?? "Could not load project health.");
    }
    setData(body as ProjectDataQualityResponse);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    // Initial project-scoped diagnostics request; state changes occur
    // only from the awaited external response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : "Could not load project health.");
      }
    });
    return () => {
      active = false;
    };
  }, [load]);

  async function dismissIssue(issue: ProjectDataQualityIssue) {
    setBusyCode(issue.code);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/data-quality/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: issue.code,
          fingerprint: issue.fingerprint,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Could not dismiss this issue.");
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not dismiss this issue.");
    } finally {
      setBusyCode(null);
    }
  }

  async function restoreDismissed() {
    setRestoring(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/data-quality/dismiss`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Could not restore dismissed issues.");
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore dismissed issues.");
    } finally {
      setRestoring(false);
    }
  }

  if (error) {
    return (
      <div className="border border-red-700/30 bg-red-50 px-4 py-3 text-body text-red-800">
        Project health could not be loaded: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="border border-[#dcd6cc] bg-offwhite px-4 py-3 text-body text-charcoal/50">
        Checking project data quality…
      </div>
    );
  }

  const issueCount = data.summary.critical + data.summary.warning + data.summary.info;
  const dismissedCount = data.dismissed_count ?? 0;
  const openByDefault = data.summary.critical > 0;

  return (
    <section className="border border-[#dcd6cc] bg-offwhite p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="label-caps">Project health</p>
          <p className="mt-1 text-body text-charcoal/60">
            Checks across the register, pricing, purchasing and trade programme.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.summary.critical > 0 && (
            <span className="border border-red-700/30 bg-red-50 px-2.5 py-1 text-caption text-red-800">
              {data.summary.critical} critical
            </span>
          )}
          {data.summary.warning > 0 && (
            <span className="border border-amber-700/30 bg-amber-50 px-2.5 py-1 text-caption text-amber-900">
              {data.summary.warning} warnings
            </span>
          )}
          {issueCount === 0 && (
            <span className="border border-emerald-700/30 bg-emerald-50 px-2.5 py-1 text-caption text-emerald-800">
              No data gaps found
            </span>
          )}
          {dismissedCount > 0 && (
            <button
              type="button"
              disabled={restoring}
              onClick={() => void restoreDismissed()}
              className="border border-[#c9c2b4] px-2.5 py-1 text-caption text-charcoal/55 hover:border-nearblack hover:text-nearblack disabled:opacity-40"
            >
              {restoring
                ? "Restoring…"
                : `Restore ${dismissedCount} dismissed`}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="border border-[#e5e0d6] bg-nearwhite p-3">
          <p className="text-section font-display text-nearblack">{data.pricing.priced_item_pct}%</p>
          <p className="text-caption text-charcoal/50">Items with a usable price</p>
        </div>
        <div className="border border-[#e5e0d6] bg-nearwhite p-3">
          <p className="text-section font-display text-nearblack">{data.pricing.quoted_value_pct}%</p>
          <p className="text-caption text-charcoal/50">Known value backed by trade quotes</p>
        </div>
        <div className="border border-[#e5e0d6] bg-nearwhite p-3">
          <p className="text-section font-display text-nearblack">
            {formatMoney(data.pricing.known_value_ex_gst)}
          </p>
          <p className="text-caption text-charcoal/50">FF&amp;E known value ex GST</p>
        </div>
        <div className="border border-[#e5e0d6] bg-nearwhite p-3">
          <p className="text-section font-display text-nearblack">{data.summary.affected_records}</p>
          <p className="text-caption text-charcoal/50">Records needing review</p>
        </div>
      </div>

      {issueCount > 0 && (
        <details className="mt-4" open={openByDefault}>
          <summary className="cursor-pointer text-body font-medium text-nearblack">
            Review {issueCount} {issueCount === 1 ? "data-quality issue" : "data-quality issues"}
          </summary>
          <ul className="mt-2">
            {data.issues.map((issue) => (
              <IssueRow
                key={issue.code}
                issue={issue}
                busy={busyCode === issue.code}
                onDismiss={() => void dismissIssue(issue)}
              />
            ))}
          </ul>
        </details>
      )}

      <p className="mt-4 text-caption leading-relaxed text-charcoal/45">
        Register and pricing gaps can be dismissed from this overview. They return automatically
        if the affected records change. Procurement deadlines and programme risks remain active
        until the underlying issue is resolved.
      </p>
    </section>
  );
}
