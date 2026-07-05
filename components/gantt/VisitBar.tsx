"use client";

import type { VisitStatus } from "@/lib/trade-visits";

const STATUS_DOT: Record<VisitStatus, string> = {
  unconfirmed: "#c9c2b4",
  tentative: "#B98A4A",
  confirmed: "#5F8A82",
  declined: "#8a3f3f",
  proposed_change: "#A08C72",
};

const STATUS_LABEL: Record<VisitStatus, string> = {
  unconfirmed: "Unconfirmed",
  tentative: "Tentative",
  confirmed: "Confirmed",
  declined: "Declined",
  proposed_change: "Proposed change",
};

/**
 * A single compact status dot for the phase-row overview strip (see
 * GanttChart.tsx's rendering-decision comment) — NOT a full bar with
 * its own grid position. Kept intentionally tiny/summary-only; full
 * per-visit detail (dates, contact, arrival) lives in the phase edit
 * panel / mobile bottom sheet instead. Tapping opens the bottom sheet
 * on mobile, or is a no-op on desktop (desktop staff use the edit
 * panel, opened via the phase name, for full visit management).
 */
export function VisitBar({
  companyLabel,
  status,
  onTap,
}: {
  companyLabel: string;
  status: VisitStatus;
  onTap?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      title={`${companyLabel} — ${STATUS_LABEL[status]}`}
      className="inline-flex h-3 w-3 shrink-0 border border-black/10"
      style={{ backgroundColor: STATUS_DOT[status] }}
    />
  );
}

export function VisitStatusLabel({ status }: { status: VisitStatus }) {
  return <span className="text-caption text-charcoal/50">{STATUS_LABEL[status]}</span>;
}
