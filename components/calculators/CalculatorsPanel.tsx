"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type { Material } from "@/types/round-b";
import { TimberFrameCalculator } from "./TimberFrameCalculator";
import { PlasterboardCalculator } from "./PlasterboardCalculator";
import { BrickCalculator } from "./BrickCalculator";

interface Props {
  /**
   * Accepted for API symmetry with every other EstimateWorkspace child
   * view (EstimateView/VariationsView/MeasurementsView all take
   * projectId) and so a future calculator-scoped route (e.g. saved
   * calculator presets per project) has it available without a prop
   * change. Currently unused in the component body: materials are a
   * global list (GET /api/materials has no project scoping) and the
   * insert-line route is section-scoped (the section already carries
   * an implicit project_id server-side) — destructured as `_projectId`
   * below to make that "accepted but not yet needed" status explicit
   * rather than silently dropping it from the prop list.
   */
  projectId: string;
  /** Section id/name list — passed down from EstimateWorkspace, which already has the full sections tree loaded. */
  sections: { id: string; name: string }[];
  /** Bubbles a newly-created cost line up so EstimateWorkspace can fold it into its shared estimate state (recomputing rollups) exactly like every other "add line" action already does. */
  onLineInserted: (line: unknown) => void;
}

type CalcTab = "timber" | "plasterboard" | "brick";

/**
 * Calculators — BUILD-SPEC.md "Phillip's ideas list — 6 July 2026"
 * item 4: "calculators incl. materials price list". Mounted as a new
 * tab inside the (already admin-gated, see
 * app/(dashboard)/projects/[id]/estimate/page.tsx) Estimate workspace —
 * see EstimateWorkspace.tsx's View union/tab strip for the wiring.
 *
 * Owns the ONE shared fetch of the global materials list (GET
 * /api/materials) so both calculators (and any future ones) work off
 * the same in-memory list rather than each fetching its own copy —
 * mirrors EstimateWorkspace's own "shared fetch/refresh cycle, folded
 * into local state on mutation" pattern one level up.
 */
export function CalculatorsPanel({ projectId: _projectId, sections, onLineInserted }: Props) {
  const [tab, setTab] = useState<CalcTab>("timber");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMaterials = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/materials");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not load materials.");
      setMaterials(body.materials ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load materials.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMaterials();
  }, [loadMaterials]);

  function handleMaterialAdded(material: Material) {
    setMaterials((cur) => [...cur, material].sort((a, b) => a.name.localeCompare(b.name)));
  }
  function handleMaterialUpdated(material: Material) {
    setMaterials((cur) => cur.map((m) => (m.id === material.id ? material : m)));
  }

  /**
   * "Insert as estimate line" — POSTs a real cost_line into the chosen
   * section via the SAME route components/estimate/EstimateView.tsx's
   * own "add line" action uses (POST
   * /api/estimate/sections/[sectionId]/lines), so the new line
   * immediately participates in every existing rollup/PATCH/versioning
   * flow with no special-casing anywhere else in the app. `notes`
   * carries the auto-composed provenance string (calculator name +
   * inputs summary) per BUILD-SPEC.md "description auto-composed +
   * provenance note".
   */
  async function insertLine(input: {
    sectionId: string;
    description: string;
    notes: string;
    qty: number | null;
    unit: string | null;
    cost_ex_gst: number | null;
  }) {
    const res = await fetch(`/api/estimate/sections/${input.sectionId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: input.description,
        notes: input.notes,
        qty: input.qty,
        unit: input.unit,
        cost_ex_gst: input.cost_ex_gst,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error ?? "Could not insert estimate line.");
    }
    onLineInserted(body.line);
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="flex border border-[#c9c2b4]">
        {(
          [
            { key: "timber", label: "Timber frame" },
            { key: "plasterboard", label: "Plasterboard" },
            { key: "brick", label: "Brick" },
          ] as { key: CalcTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={clsx(
              "px-4 py-2 text-subhead transition-colors",
              tab === t.key ? "bg-nearblack text-white" : "text-charcoal hover:bg-nearwhite"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-body text-charcoal/50">Loading materials…</p>
      ) : tab === "timber" ? (
        <TimberFrameCalculator
          materials={materials}
          onMaterialAdded={handleMaterialAdded}
          onMaterialUpdated={handleMaterialUpdated}
          onInsertLine={insertLine}
          sections={sections}
        />
      ) : tab === "plasterboard" ? (
        <PlasterboardCalculator
          materials={materials}
          onMaterialAdded={handleMaterialAdded}
          onMaterialUpdated={handleMaterialUpdated}
          onInsertLine={insertLine}
          sections={sections}
        />
      ) : (
        <BrickCalculator
          materials={materials}
          onMaterialAdded={handleMaterialAdded}
          onMaterialUpdated={handleMaterialUpdated}
          onInsertLine={insertLine}
          sections={sections}
        />
      )}
    </div>
  );
}
