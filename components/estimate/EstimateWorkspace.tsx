"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type { CostLine, EstimateResponse, MeasurementGroupWithRows, MeasurementWithGroup, Variation } from "@/types";
import { approvedVariationsTotal, projectRollup, sectionRollup, wholeJobSummary } from "@/lib/estimate";
import { EstimateView } from "./EstimateView";
import { VariationsView } from "./VariationsView";
import { MeasurementsView } from "./MeasurementsView";
import { VersionsPanel } from "./VersionsPanel";

type View = "estimate" | "variations" | "measurements" | "versions";

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
 *
 * Week 7 line-entry UX fix (user-reported: per-cell save + full page
 * refresh made line entry painful): `onReload` (a full loadAll()
 * re-fetch of all three endpoints) is now reserved for structural
 * changes only (initialise from template, add/rename/delete a
 * section/group — where the shape of the tree itself changed and a
 * full re-derive is the simplest correct thing). Line/row-level edits
 * instead go through the onLineChanged/onVariationChanged/
 * onMeasurementChanged callbacks below, which patch local state
 * in-place — no network round-trip beyond the single PATCH/POST the
 * row itself issued, and the sticky summary / rollups recompute
 * instantly from that local state because lib/estimate.ts's rollup
 * functions are pure and already run client-side (see EstimateView).
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

  // ── local, in-place mutation helpers (Week 7 line-entry UX fix) ──
  // These update the already-loaded tree directly, so a single line
  // edit/add never re-fetches the other two tabs' data or re-renders
  // the whole page from a network round-trip. Each child view is
  // still responsible for the optimistic-update + rollback dance
  // around its own PATCH/POST call (see EstimateView/VariationsView/
  // MeasurementsView) — these helpers are just where the resulting
  // "here's the new/changed row" gets folded back into shared state.
  //
  // Every helper that can move a number the sticky summary shows also
  // recomputes `estimate.rollup`/`section.rollup`/`estimate.ffe`/
  // `estimate.wholeJob` right here, client-side, using the exact same
  // pure functions (lib/estimate.ts) the server uses for the initial
  // load — so the summary strip updates the instant a row saves, with
  // no extra round-trip and no drift from the server's own math.

  /** Re-derive every rollup in `estimate` from its current sections/measurements + the given variations. */
  function recomputeRollups(
    est: EstimateResponse,
    sections: EstimateResponse["sections"],
    variationsForRollup: Pick<Variation, "status" | "cost_ex_gst">[]
  ): EstimateResponse {
    const measurementsById = new Map(est.measurements.map((m) => [m.id, { value: m.value }]));
    const sectionsWithRollups = sections.map((s) => ({
      ...s,
      rollup: sectionRollup(s.lines, measurementsById),
    }));
    const allLines = sectionsWithRollups.flatMap((s) => s.lines);
    const rollup = projectRollup({
      lines: allLines,
      variations: variationsForRollup,
      markupPct: est.markup_pct,
      measurementsById,
    });
    const wholeJob = wholeJobSummary(rollup, est.ffe);
    return { ...est, sections: sectionsWithRollups, rollup, wholeJob };
  }

  /** Replace one cost line in place, wherever its section is, then recompute totals. */
  const patchLineLocal = useCallback((line: CostLine) => {
    setEstimate((cur) => {
      if (!cur) return cur;
      const sections = cur.sections.map((s) =>
        s.id === line.section_id
          ? { ...s, lines: s.lines.map((l) => (l.id === line.id ? line : l)) }
          : s
      );
      return recomputeRollups(cur, sections, variations);
    });
  }, [variations]);

  /** Append a newly-created cost line to its section, then recompute totals. */
  const addLineLocal = useCallback((line: CostLine) => {
    setEstimate((cur) => {
      if (!cur) return cur;
      const sections = cur.sections.map((s) =>
        s.id === line.section_id ? { ...s, lines: [...s.lines, line] } : s
      );
      return recomputeRollups(cur, sections, variations);
    });
  }, [variations]);

  /** Remove a cost line from local state (after a successful DELETE), then recompute totals. */
  const removeLineLocal = useCallback((sectionId: string, lineId: string) => {
    setEstimate((cur) => {
      if (!cur) return cur;
      const sections = cur.sections.map((s) =>
        s.id === sectionId ? { ...s, lines: s.lines.filter((l) => l.id !== lineId) } : s
      );
      return recomputeRollups(cur, sections, variations);
    });
  }, [variations]);

  // Variations feed projectRollup via approvedVariationsTotal, so every
  // variation mutation also recomputes `estimate`'s rollups (using the
  // NEW variations list, not the stale closure) in addition to updating
  // the variations list itself.
  const patchVariationLocal = useCallback((variation: Variation) => {
    setVariations((cur) => {
      const next = cur.map((v) => (v.id === variation.id ? variation : v));
      setEstimate((est) => (est ? recomputeRollups(est, est.sections, next) : est));
      return next;
    });
  }, []);

  const addVariationLocal = useCallback((variation: Variation) => {
    setVariations((cur) => {
      const next = [...cur, variation];
      setEstimate((est) => (est ? recomputeRollups(est, est.sections, next) : est));
      return next;
    });
  }, []);

  const removeVariationLocal = useCallback((id: string) => {
    setVariations((cur) => {
      const next = cur.filter((v) => v.id !== id);
      setEstimate((est) => (est ? recomputeRollups(est, est.sections, next) : est));
      return next;
    });
  }, []);

  // Measurement edits (value/wastage) change effectiveQty() for every
  // cost line linked to that measurement, which changes that line's
  // computed cost — so a measurement patch also refreshes
  // `estimate.measurements` and recomputes rollups against the new
  // measurement value, even though no cost_lines row itself changed.
  const patchMeasurementLocal = useCallback(
    (groupId: string, measurement: MeasurementGroupWithRows["measurements"][number]) => {
      setMeasurementGroups((cur) =>
        cur.map((g) =>
          g.id === groupId
            ? { ...g, measurements: g.measurements.map((m) => (m.id === measurement.id ? measurement : m)) }
            : g
        )
      );
      setEstimate((est) => {
        if (!est) return est;
        const groupName = est.measurements.find((m) => m.id === measurement.id)?.group_name ?? "";
        const measurements: MeasurementWithGroup[] = est.measurements.map((m) =>
          m.id === measurement.id ? { ...measurement, group_name: groupName } : m
        );
        const withMeasurements = { ...est, measurements };
        return recomputeRollups(withMeasurements, withMeasurements.sections, variations);
      });
    },
    [variations]
  );

  const addMeasurementLocal = useCallback(
    (groupId: string, measurement: MeasurementGroupWithRows["measurements"][number]) => {
      setMeasurementGroups((cur) =>
        cur.map((g) => (g.id === groupId ? { ...g, measurements: [...g.measurements, measurement] } : g))
      );
      setEstimate((est) => {
        if (!est) return est;
        const group = measurementGroups.find((g) => g.id === groupId);
        const measurements: MeasurementWithGroup[] = [
          ...est.measurements,
          { ...measurement, group_name: group?.name ?? "" },
        ];
        return { ...est, measurements };
      });
    },
    [measurementGroups]
  );

  const removeMeasurementLocal = useCallback((groupId: string, measurementId: string) => {
    setMeasurementGroups((cur) =>
      cur.map((g) =>
        g.id === groupId
          ? { ...g, measurements: g.measurements.filter((m) => m.id !== measurementId) }
          : g
      )
    );
    // A deleted measurement can't still be linked (PATCH /api/estimate/lines/[id]
    // would 400 on a stale FK, and the DB column is ON DELETE SET NULL
    // regardless), so no line-level recompute is needed here beyond
    // dropping it from the local measurements list.
    setEstimate((est) =>
      est ? { ...est, measurements: est.measurements.filter((m) => m.id !== measurementId) } : est
    );
  }, []);

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

      {/* Whole-job summary strip — trades (all-trades + approved
          variations + markup) folded with FF&E, added AFTER markup per
          the Estimate ↔ Schedule integration cascade decision (see
          lib/estimate.ts wholeJobSummary() for the full rationale). */}
      {estimate && !notInitialised && (
        <div className="border border-nearblack bg-offwhite px-6 py-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="label-caps mb-1">Whole job total — inc GST</p>
              <p className="font-display text-section text-nearblack">
                {formatMoney(estimate.wholeJob.combinedIncGst)}
              </p>
            </div>
            <p className="max-w-sm text-caption text-charcoal/50">
              Trades {formatMoney(estimate.rollup.totalIncGst)} inc GST + FF&E{" "}
              {formatMoney(estimate.ffe.total)} ex GST. FF&E is priced
              separately from the trade estimate and is not marked up by
              the trade markup % below — see the FF&E section for its own
              quoted/placeholder split.
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
            { key: "versions", label: "Versions" },
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
          onLineAdded={addLineLocal}
          onLineChanged={patchLineLocal}
          onLineRemoved={removeLineLocal}
          approvedVariationsTotal={approvedVariations}
          measurements={estimate?.measurements ?? []}
        />
      )}

      {view === "variations" && (
        <VariationsView
          projectId={projectId}
          variations={variations}
          onReload={loadAll}
          onVariationAdded={addVariationLocal}
          onVariationChanged={patchVariationLocal}
          onVariationRemoved={removeVariationLocal}
        />
      )}

      {view === "measurements" && (
        <MeasurementsView
          projectId={projectId}
          groups={measurementGroups}
          onReload={loadAll}
          onMeasurementAdded={addMeasurementLocal}
          onMeasurementChanged={patchMeasurementLocal}
          onMeasurementRemoved={removeMeasurementLocal}
        />
      )}

      {view === "versions" && <VersionsPanel projectId={projectId} />}
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
