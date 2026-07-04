"use client";

import clsx from "clsx";
import type { Lead } from "@/types";
import { formatCompactValue, isFollowUpPastDue, leadAgeDays } from "@/lib/leads";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * List (table) view toggle — BUILD-SPEC.md "list-view toggle (table:
 * name, stage, location, age, follow-up, visit date, values)".
 */
export function LeadsList({ leads, onOpen }: { leads: Lead[]; onOpen: (lead: Lead) => void }) {
  if (leads.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">No leads match this view.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-[#dcd6cc] bg-offwhite">
      <table className="w-full min-w-[900px] text-body">
        <thead>
          <tr className="border-b border-[#dcd6cc] text-left">
            <th className="label-caps px-3 py-2 !text-charcoal/50">Name</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Stage</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Location</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Age</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Follow-up</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Visit date</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Construction</th>
            <th className="label-caps px-3 py-2 !text-charcoal/50">Design</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const pastDue = isFollowUpPastDue(lead.follow_up_date);
            return (
              <tr
                key={lead.id}
                onClick={() => onOpen(lead)}
                className="cursor-pointer border-b border-[#e5e0d6] hover:bg-cream"
              >
                <td className="px-3 py-2 text-nearblack">
                  {lead.surname_project}
                  {lead.first_name && <span className="text-charcoal/50"> · {lead.first_name}</span>}
                </td>
                <td className="px-3 py-2 text-charcoal/70">{lead.stage}</td>
                <td className="px-3 py-2 text-charcoal/70">{lead.location ?? "—"}</td>
                <td className="px-3 py-2 text-charcoal/70">{leadAgeDays(lead)}d</td>
                <td className={clsx("px-3 py-2", pastDue ? "font-semibold text-red-700" : "text-charcoal/70")}>
                  {formatDate(lead.follow_up_date)}
                </td>
                <td className="px-3 py-2 text-charcoal/70">{formatDate(lead.site_visit_date)}</td>
                <td className="px-3 py-2 text-charcoal/70">{formatCompactValue(lead.construction_value)}</td>
                <td className="px-3 py-2 text-charcoal/70">{formatCompactValue(lead.design_value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
