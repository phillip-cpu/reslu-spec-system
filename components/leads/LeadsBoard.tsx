"use client";

import { useState } from "react";
import clsx from "clsx";
import { LEAD_STAGES, INACTIVE_LEAD_STAGES, type Lead, type LeadStage } from "@/types";
import { LeadCard } from "./LeadCard";

interface Props {
  leads: Lead[];
  onMoveStage: (lead: Lead, stage: LeadStage) => void;
  onOpen: (lead: Lead) => void;
}

/**
 * Leads kanban — BUILD-SPEC.md "kanban by stage (reuse board
 * patterns) ... columns = the 10 stages in pipeline order, horizontal
 * scroll; drag = stage change via PATCH; lost/complete/future stages
 * visually muted at the end."
 *
 * Stage is a fixed 10-value enum (not user-editable columns like
 * components/board/ProjectBoard.tsx) — the grouping/drag shape this
 * copies is components/items/ProcurementBoardView.tsx (fixed status
 * columns, drag = PATCH the grouping field), not the free-column
 * board. No `sort` column exists on leads (BUILD-SPEC does not list
 * one) — cards within a column are ordered by `updated_at` desc, same
 * as the default /api/leads list order, so the most recently touched
 * lead in a stage surfaces first.
 */
export function LeadsBoard({ leads, onMoveStage, onOpen }: Props) {
  const [dragLeadId, setDragLeadId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<LeadStage | null>(null);

  const columns = LEAD_STAGES.map((stage) => ({
    stage,
    muted: INACTIVE_LEAD_STAGES.includes(stage),
    leads: leads.filter((l) => l.stage === stage),
  }));

  function handleDrop(stage: LeadStage) {
    setDragOverStage(null);
    if (!dragLeadId) return;
    const lead = leads.find((l) => l.id === dragLeadId);
    setDragLeadId(null);
    if (!lead || lead.stage === stage) return;
    onMoveStage(lead, stage);
  }

  if (leads.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">No leads yet. Add one to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-4">
      {columns.map((column) => (
        <div
          key={column.stage}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverStage(column.stage);
          }}
          onDragLeave={() => setDragOverStage(null)}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(column.stage);
          }}
          className={clsx(
            "w-64 shrink-0 border bg-offwhite",
            column.muted && "opacity-60",
            dragOverStage === column.stage ? "border-nearblack" : "border-[#dcd6cc]"
          )}
        >
          <div className="border-b border-[#dcd6cc] px-3 py-2">
            <span className={clsx("label-caps", column.muted ? "!text-charcoal/40" : "!text-nearblack")}>
              {column.stage} · {column.leads.length}
            </span>
          </div>
          <div className="space-y-2 p-2">
            {column.leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                dragOver={false}
                onDragStart={() => setDragLeadId(lead.id)}
                onClick={() => onOpen(lead)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
