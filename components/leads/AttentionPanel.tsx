"use client";

import { useState } from "react";
import type { Lead, LeadsAttentionResponse } from "@/types";
import { formatCompactValue, leadAgeDays } from "@/lib/leads";

interface Props {
  attention: LeadsAttentionResponse;
  onOpen: (lead: Lead) => void;
  onSetFollowUp: (lead: Lead, date: string) => void;
}

const GROUPS: { key: keyof LeadsAttentionResponse; label: string; hint: string }[] = [
  { key: "follow_ups_due", label: "Follow-ups due", hint: "Follow-up date is today or past" },
  { key: "nurture", label: "Nurture", hint: "Proposal Sent ≥ 4 days" },
  { key: "stale_proposals", label: "Stale proposals", hint: "Awaiting to Send Proposal ≥ 7 days" },
  { key: "site_visits_upcoming", label: "Site visits (next 7 days)", hint: "Site visit booked soon" },
];

/**
 * Needs-attention panel — BUILD-SPEC.md "Needs-attention panel:
 * Proposal Sent >=4 days (nurture candidates) + Awaiting to Send
 * Proposal >=7 days (stale proposals) + follow_up_date due/past" +
 * "site_visits_upcoming: next 7 days", "rendering those groups with
 * per-lead quick actions (open, set follow-up)". Sits at the top of
 * /leads, above the pipeline dashboard strip and board/list.
 *
 * A lead can legitimately appear in more than one group (see
 * lib/leads.ts computeAttentionGroups doc comment) — rendered as-is,
 * duplication across groups is intentional signal, not deduped.
 */
export function AttentionPanel({ attention, onOpen, onSetFollowUp }: Props) {
  const nonEmpty = GROUPS.filter((g) => attention[g.key].length > 0);

  if (nonEmpty.length === 0) {
    return (
      <div className="border border-[#dcd6cc] bg-offwhite p-4">
        <p className="label-caps !text-charcoal/50">Needs attention</p>
        <p className="mt-1 text-body text-charcoal/60">Nothing needs attention right now.</p>
      </div>
    );
  }

  return (
    <div className="border border-[#dcd6cc] bg-offwhite p-4">
      <p className="label-caps mb-3 !text-charcoal/50">Needs attention</p>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {nonEmpty.map((group) => (
          <div key={group.key}>
            <p className="text-subhead text-nearblack">
              {group.label} <span className="text-charcoal/40">· {attention[group.key].length}</span>
            </p>
            <p className="mb-2 text-caption text-charcoal/40">{group.hint}</p>
            <ul className="space-y-1.5">
              {attention[group.key].map((lead) => (
                <AttentionRow
                  key={lead.id}
                  lead={lead}
                  showFollowUpAction={group.key === "follow_ups_due"}
                  onOpen={() => onOpen(lead)}
                  onSetFollowUp={(date) => onSetFollowUp(lead, date)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function AttentionRow({
  lead,
  showFollowUpAction,
  onOpen,
  onSetFollowUp,
}: {
  lead: Lead;
  showFollowUpAction: boolean;
  onOpen: () => void;
  onSetFollowUp: (date: string) => void;
}) {
  const [settingFollowUp, setSettingFollowUp] = useState(false);
  const [date, setDate] = useState("");

  return (
    <li className="border border-[#e5e0d6] bg-cream p-2">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <p className="truncate text-body text-nearblack">{lead.surname_project}</p>
          <p className="truncate text-caption text-charcoal/50">
            {leadAgeDays(lead)}d old
            {lead.construction_value != null && ` · ${formatCompactValue(lead.construction_value)}`}
          </p>
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="text-caption text-charcoal/60 hover:text-nearblack hover:underline"
        >
          Open
        </button>
        {showFollowUpAction && (
          <>
            <span className="text-caption text-charcoal/30">·</span>
            {settingFollowUp ? (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  autoFocus
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="border border-[#c9c2b4] bg-nearwhite px-1 py-0.5 text-caption focus:border-nearblack focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (date) onSetFollowUp(date);
                    setSettingFollowUp(false);
                  }}
                  className="text-caption text-charcoal/60 hover:text-nearblack"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSettingFollowUp(true)}
                className="text-caption text-charcoal/60 hover:text-nearblack hover:underline"
              >
                Set follow-up
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
