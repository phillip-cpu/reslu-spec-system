"use client";

import clsx from "clsx";
import type { Lead } from "@/types";
import { formatCompactValue, isFollowUpPastDue, leadAgeDays } from "@/lib/leads";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

/**
 * Kanban card — BUILD-SPEC.md "card: surname_project, first_name,
 * location, lead age ('12 days'), follow_up_date (red past-due),
 * site_visit_date, construction_value compact ('$650k')".
 */
export function LeadCard({
  lead,
  draggable = true,
  onDragStart,
  onDragOver,
  onDrop,
  onDragLeave,
  dragOver = false,
  onClick,
}: {
  lead: Lead;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  dragOver?: boolean;
  onClick?: () => void;
}) {
  const pastDue = isFollowUpPastDue(lead.follow_up_date);
  const followUp = formatDate(lead.follow_up_date);
  const siteVisit = formatDate(lead.site_visit_date);

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
      onClick={onClick}
      className={clsx(
        "cursor-pointer border bg-cream p-2 shadow-sm",
        draggable && "cursor-move",
        dragOver ? "border-nearblack" : "border-[#dcd6cc]"
      )}
    >
      <p className="truncate text-body text-nearblack">
        {lead.surname_project}
        {lead.first_name && (
          <span className="text-charcoal/50"> · {lead.first_name}</span>
        )}
      </p>
      {lead.location && (
        <p className="truncate text-caption text-charcoal/50">{lead.location}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-caption text-charcoal/50">{leadAgeDays(lead)}d old</span>

        {followUp && (
          <span className={clsx("text-caption", pastDue ? "font-semibold text-red-700" : "text-charcoal/50")}>
            {pastDue ? "⚠ " : "FU "}
            {followUp}
          </span>
        )}

        {siteVisit && <span className="text-caption text-charcoal/50">Visit {siteVisit}</span>}

        {lead.construction_value != null && (
          <span className="label-caps border border-sand px-1.5 py-0.5 !text-sand">
            {formatCompactValue(lead.construction_value)}
          </span>
        )}
      </div>
    </div>
  );
}
