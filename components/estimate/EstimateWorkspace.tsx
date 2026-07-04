"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type { EstimateResponse, MeasurementGroupWithRows, Variation } from "@/types";
import { approvedVariationsTotal } from "@/lib/estimate";
import { EstimateView } from "./EstimateView";
import { VariationsView } from "./VariationsView";
import { MeasurementsView } from "./MeasurementsView";

type View = "estimate" | "variations" | "measurements";

interface Props {
  projectId: string;
}

/**
 * Owns the shared fetch/refresh cycle for the Estimate module and
 * switches between the three views (tab strip within the page, per
 * the build brief) — mirrors ProjectWorkspace's role for the spec
 * register (components/items/ProjectWorkspace.tsx).
 *
 * All three views read admin-gated data from app/api/projects/[id]/estimate/**
 * and app/api/estimate/**; every fetch here hits routes that
 * independently re-check admin role server-side, so even if this
 * component somehow rendered for a non-admin, no data would come back.
 */
export function EstimateWorkspace({ projectId }: Props) {
  const [view, setView] = useState<View>("estimate");
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [variations, setVariations] = useState<Variation[]>([]);
  const [measurementGroups, setMeasurementGroups] = useState<MeasurementGroupWithRows[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notInitialised, setNotInitialised] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [estimateRes, variationsRes, measurementsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/estimate`),
        fetch(`/api/projects/${projectId}/estimate/variations`),
        fetch(`/api/projects/${projectId}/estimate/measurements/groups`),
      ]);

      if (estimateRes.status === 403) {
        setError("This area is restricted.");
        return;
      }

      const estimateBody: EstimateResponse = await estimateRes.json();
      if (!estimateRes.ok) {
        throw new Error((estimateBody as unknown as { error?: string }).error ?? "Could not load estimate.");
      }
      setEstimate(estimateBody);
      setNotInitialised(estimateBody.sections.length === 0);

      const variationsBody = await variationsRes.json();
      if (variationsRes.ok) setVariations(variationsBody.variations ?? []);

      const measurementsBody = await measurementsRes.json();
      if (measurementsRes.ok) setMeasurementGroups(measurementsBody.groups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the estimate.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function initialiseFromTemplate() {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/init`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not initialise the estimate.");
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not initialise the estimate.");
    }
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Loading estimate…</p>;
  }

  if (error === "This area is restricted.") {
    return (
      <div className="mx-auto max-w-md border border-[#dcd6cc] bg-offwhite p-8 text-center">
        <p className="label-caps mb-2">Restricted</p>
        <p className="text-body text-charcoal/70">{error}</p>
      </div>
    );
  }

  const approvedVariations = approvedVariationsTotal(variations);

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {/* Whole-job summary strip */}
      {estimate && !notInitialised && (
        <div className="border border-nearblack bg-offwhite px-6 py-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="label-caps mb-1">Estimate total — inc GST</p>
              <p className="font-display text-section text-nearblack">
                {formatMoney(estimate.rollup.totalIncGst)}
              </p>
            </div>
            <p className="max-w-sm text-caption text-charcoal/50">
              FF&E client pricing joins this figure in a later release — this
              is the construction-cost estimate total only.
            </p>
          </div>
        </div>
      )}

      {/* Tab strip */}
      <div className="flex border border-[#c9c2b4]">
        {(
          [
            { key: "estimate", label: "Estimate" },
            { key: "variations", label: "Variations" },
            { key: "measurements", label: "Areas & Measurements" },
          ] as { key: View; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setView(t.key)}
            className={clsx(
              "px-4 py-2 text-subhead transition-colors",
              view === t.key
                ? "bg-nearblack text-white"
                : "text-charcoal hover:bg-nearwhite"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === "estimate" && (
        <EstimateView
          projectId={projectId}
          estimate={estimate}
          notInitialised={notInitialised}
          onInitialise={initialiseFromTemplate}
          onReload={loadAll}
          approvedVariationsTotal={approvedVariations}
        />
      )}

      {view === "variations" && (
        <VariationsView
          projectId={projectId}
          variations={variations}
          onReload={loadAll}
        />
      )}

      {view === "measurements" && (
        <MeasurementsView
          projectId={projectId}
          groups={measurementGroups}
          onReload={loadAll}
        />
      )}
    </div>
  );
}

/** Shared money formatter — display-only, uses the already-rounded values from lib/estimate.ts. */
export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
