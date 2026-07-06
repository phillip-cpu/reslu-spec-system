"use client";

import { useState } from "react";
import type { TradeVisitWithContact } from "@/lib/trade-visits";
import { formatArrival } from "@/lib/trade-visits";
import { VisitStatusLabel } from "./VisitBar";

/**
 * Mobile bottom sheet — BUILD-SPEC "Mobile: tap a visit bar -> bottom
 * sheet showing visit details + a staff 'confirm on behalf' button".
 * Simplest possible implementation: a conditionally-rendered fixed
 * inset-x-0 bottom-0 panel, no external sheet/drawer library. Shown
 * from GanttChart.tsx when a visit dot is tapped on a narrow viewport.
 */
export function VisitBottomSheet({
  visit,
  onClose,
  onConfirmed,
}: {
  visit: TradeVisitWithContact;
  onClose: () => void;
  onConfirmed: (updated: TradeVisitWithContact) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fix Round A — Trade insurance tracker: non-blocking warning from
  // POST /api/visits/[id]/confirm's insurance_warning flag — shown
  // after a successful confirm, never blocks it.
  const [insuranceWarning, setInsuranceWarning] = useState<string | null>(null);

  async function confirmOnBehalf() {
    setConfirming(true);
    setError(null);
    setInsuranceWarning(null);
    try {
      const res = await fetch(`/api/visits/${visit.id}/confirm`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not confirm visit.");
      const { visit: updated, insurance_warning } = await res.json();
      onConfirmed({ ...visit, ...updated });
      if (insurance_warning) setInsuranceWarning(insurance_warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm visit.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-lg border-t border-[#dcd6cc] bg-cream px-5 py-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 bg-charcoal/20" />
        <p className="label-caps">{visit.contact ? visit.contact.company : "No trade assigned"}</p>
        <p className="mt-1 text-body text-nearblack">
          {visit.start_date}
          {visit.end_date !== visit.start_date ? ` → ${visit.end_date}` : ""}
        </p>
        <p className="mt-1 text-body text-charcoal/70">{formatArrival(visit.arrival_slot, visit.arrival_time)}</p>
        <div className="mt-2">
          <VisitStatusLabel status={visit.status} />
        </div>
        {visit.notes && <p className="mt-2 text-caption text-charcoal/50">{visit.notes}</p>}

        {error && <p className="mt-3 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}
        {insuranceWarning && (
          <p className="mt-3 border border-sand bg-cream px-3 py-2 text-body text-charcoal">
            {insuranceWarning}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          {visit.status !== "confirmed" && (
            <button
              type="button"
              onClick={confirmOnBehalf}
              disabled={confirming}
              className="flex-1 bg-nearblack px-4 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {confirming ? "Confirming…" : "Confirm on behalf of trade"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="border border-[#c9c2b4] px-4 py-3 text-subhead text-charcoal hover:border-nearblack"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
