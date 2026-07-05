"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { formatMoney } from "./EstimateWorkspace";
import type { VersionCompareResponse } from "@/types/phase-12a-a";

interface Props {
  projectId: string;
  a: string;
  b: string;
}

/**
 * VM comparison view — BUILD-SPEC.md's explicit deliverable: "side-by-
 * side any version vs current (or vs another version): per-section
 * deltas, changed/removed/added lines highlighted, substituted FF&E
 * items (was X -> now Y, saving $Z), headline 'Total saving: $N ex
 * GST'." Pure render of GET /api/projects/[id]/versions/compare?a=&b=
 * — all diffing happens server-side (lib/estimate-versions.ts) so two
 * admins looking at the same pair never see different numbers.
 */
export function VersionCompare({ projectId, a, b }: Props) {
  const [data, setData] = useState<VersionCompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${projectId}/versions/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then((r) => r.json())
      .then((body) => {
        if (!active) return;
        if (body.error) throw new Error(body.error);
        setData(body as VersionCompareResponse);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "Could not load comparison."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId, a, b]);

  if (loading) return <p className="text-body text-charcoal/50">Comparing…</p>;
  if (error || !data) return <p className="text-body text-red-700">{error ?? "Could not load comparison."}</p>;

  const savingIsPositive = data.totalSavingExGst > 0;

  return (
    <div className="space-y-6">
      {/* Headline */}
      <div className="border border-nearblack bg-cream px-5 py-4">
        <p className="label-caps mb-1">
          {data.a.label} → {data.b.label}
        </p>
        <p
          className={clsx(
            "font-display text-section",
            savingIsPositive ? "text-[#3B6D11]" : data.totalSavingExGst < 0 ? "text-red-700" : "text-nearblack"
          )}
        >
          {savingIsPositive ? "Total saving: " : data.totalSavingExGst < 0 ? "Total increase: " : "No change: "}
          {formatMoney(Math.abs(data.totalSavingExGst))} ex GST
        </p>
        <p className="mt-1 text-caption text-charcoal/50">
          {data.a.label}: {formatMoney(data.totalA)} ex GST → {data.b.label}: {formatMoney(data.totalB)} ex GST
        </p>
      </div>

      {/* Per-section deltas */}
      {data.sections.length === 0 ? (
        <p className="text-body text-charcoal/50">No line-level differences between these two.</p>
      ) : (
        <div className="space-y-4">
          {data.sections.map((section) => (
            <div key={section.name} className="border border-[#dcd6cc]">
              <div className="flex items-center justify-between bg-cream px-4 py-2">
                <p className="label-caps !text-nearblack">{section.name}</p>
                <p
                  className={clsx(
                    "text-caption",
                    section.sectionDelta > 0
                      ? "text-[#3B6D11]"
                      : section.sectionDelta < 0
                        ? "text-red-700"
                        : "text-charcoal/50"
                  )}
                >
                  {section.sectionDelta > 0 ? "−" : section.sectionDelta < 0 ? "+" : ""}
                  {formatMoney(Math.abs(section.sectionDelta))}
                </p>
              </div>
              <div className="divide-y divide-[#e5e0d6]">
                {section.lines
                  .filter((l) => l.status !== "unchanged")
                  .map((entry, i) => (
                    <div
                      key={i}
                      className={clsx(
                        "flex items-center justify-between gap-3 px-4 py-2",
                        entry.status === "added" && "bg-[#EAF3E1]",
                        entry.status === "removed" && "bg-[#F7E7E7]",
                        entry.status === "changed" && "bg-[#FBF1E0]"
                      )}
                    >
                      <div>
                        <span className="label-caps mr-2 !text-charcoal/40">{STATUS_LABEL[entry.status]}</span>
                        <span className="text-body text-charcoal">
                          {entry.line?.description ?? entry.previous?.description}
                        </span>
                        {entry.status === "changed" && entry.previous && entry.line && (
                          <p className="text-caption text-charcoal/50">
                            was: {entry.previous.description}
                          </p>
                        )}
                      </div>
                      <p
                        className={clsx(
                          "shrink-0 text-body",
                          (entry.costDelta ?? 0) > 0
                            ? "text-red-700"
                            : (entry.costDelta ?? 0) < 0
                              ? "text-[#3B6D11]"
                              : "text-charcoal/50"
                        )}
                      >
                        {entry.costDelta === null ? "—" : formatDelta(entry.costDelta)}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* FF&E substitutions */}
      {data.ffeSubstitutions.length > 0 && (
        <div className="border border-[#dcd6cc]">
          <div className="bg-cream px-4 py-2">
            <p className="label-caps !text-nearblack">FF&E substitutions</p>
          </div>
          <div className="divide-y divide-[#e5e0d6]">
            {data.ffeSubstitutions.map((sub) => (
              <div key={sub.item_code} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
                <div>
                  <p className="text-body text-nearblack">{sub.item_code}</p>
                  <p className="text-caption text-charcoal/50">
                    {sub.was ? sub.was.name : "— (added)"} → {sub.now ? sub.now.name : "— (removed)"}
                  </p>
                </div>
                <p
                  className={clsx(
                    "text-body",
                    sub.saving > 0 ? "text-[#3B6D11]" : sub.saving < 0 ? "text-red-700" : "text-charcoal/50"
                  )}
                >
                  {sub.saving > 0 ? "Saving " : sub.saving < 0 ? "Increase " : ""}
                  {formatMoney(Math.abs(sub.saving))}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

function formatDelta(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(value))}`;
}
