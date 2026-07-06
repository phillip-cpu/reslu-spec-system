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
 * Leads pipeline — BUILD-SPEC.md §"Board vertical layout" (fix round
 * B): "the Leads pipeline: stages stacked vertically in pipeline
 * order, active stages first, muted stages (Unable to Contact / Lead
 * Lost / Complete / Potential Future) collapsed at the bottom with
 * counts (expand on click) ... Vertical is the universal default
 * across every board surface."
 *
 * Was a horizontal-scroll kanban (BUILD-SPEC.md's original "Leads
 * pipeline" spec); this fix round replaces that with stacked full-width
 * sections in LEAD_STAGES order — active stages render open by
 * default, each a compact card list; the four INACTIVE_LEAD_STAGES
 * stages are grouped into a single collapsed-by-default footer strip
 * showing each stage's count, expandable per-stage on click. Drag
 * between sections still changes stage via the same onMoveStage prop
 * (PATCH), including dragging into a still-collapsed muted stage
 * (drop target stays active even while collapsed — the header itself
 * is the drop zone).
 *
 * Stage is a fixed 10-value enum (not user-editable columns like
 * components/board/ProjectBoard.tsx) — the grouping/drag shape this
 * copies is components/items/ProcurementBoardView.tsx (fixed status
 * groups, drag = PATCH the grouping field), not the free-column board.
 * No `sort` column exists on leads (BUILD-SPEC does not list one) —
 * cards within a stage are ordered by `updated_at` desc, same as the
 * default /api/leads list order, so the most recently touched lead in
 * a stage surfaces first.
 */
export function LeadsBoard({ leads, onMoveStage, onOpen }: Props) {
  const [dragLeadId, setDragLeadId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<LeadStage | null>(null);
  const [expandedMuted, setExpandedMuted] = useState<Set<LeadStage>>(new Set());

  const activeStages = LEAD_STAGES.filter((s) => !INACTIVE_LEAD_STAGES.includes(s));
  const mutedStages = LEAD_STAGES.filter((s) => INACTIVE_LEAD_STAGES.includes(s));

  const leadsByStage = new Map<LeadStage, Lead[]>(
    LEAD_STAGES.map((stage) => [stage, leads.filter((l) => l.stage === stage)])
  );

  function handleDrop(stage: LeadStage) {
    setDragOverStage(null);
    if (!dragLeadId) return;
    const lead = leads.find((l) => l.id === dragLeadId);
    setDragLeadId(null);
    if (!lead || lead.stage === stage) return;
    onMoveStage(lead, stage);
  }

  function toggleMuted(stage: LeadStage) {
    setExpandedMuted((cur) => {
      const next = new Set(cur);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  if (leads.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">No leads yet. Add one to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {activeStages.map((stage) => {
        const stageLeads = leadsByStage.get(stage) ?? [];
        return (
          <div
            key={stage}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverStage(stage);
            }}
            onDragLeave={() => setDragOverStage(null)}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(stage);
            }}
            className={clsx(
              "border bg-offwhite",
              dragOverStage === stage ? "border-nearblack" : "border-[#dcd6cc]"
            )}
          >
            <div className="border-b border-[#dcd6cc] px-3 py-2">
              <span className="label-caps !text-nearblack">
                {stage} · {stageLeads.length}
              </span>
            </div>
            {stageLeads.length === 0 ? (
              <p className="px-3 py-3 text-caption text-charcoal/40">No leads in this stage.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-2 lg:grid-cols-3">
                {stageLeads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    dragOver={false}
                    onDragStart={() => setDragLeadId(lead.id)}
                    onClick={() => onOpen(lead)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Muted stages — Unable to Contact / Lead Lost / Complete /
          Potential Future Lead — collapsed at the bottom with counts,
          each independently expandable on click. */}
      <div className="space-y-2 border-t border-[#dcd6cc] pt-4">
        <p className="label-caps !text-charcoal/40">Inactive stages</p>
        {mutedStages.map((stage) => {
          const stageLeads = leadsByStage.get(stage) ?? [];
          const expanded = expandedMuted.has(stage);
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStage(stage);
              }}
              onDragLeave={() => setDragOverStage(null)}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(stage);
              }}
              className={clsx(
                "border bg-offwhite opacity-70 transition-opacity hover:opacity-100",
                dragOverStage === stage ? "border-nearblack opacity-100" : "border-[#dcd6cc]"
              )}
            >
              <button
                type="button"
                onClick={() => toggleMuted(stage)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="text-caption text-charcoal/40">{expanded ? "▾" : "▸"}</span>
                <span className="label-caps !text-charcoal/40">
                  {stage} · {stageLeads.length}
                </span>
              </button>
              {expanded && (
                stageLeads.length === 0 ? (
                  <p className="px-3 py-3 text-caption text-charcoal/40">No leads in this stage.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 border-t border-[#e5e0d6] p-2 sm:grid-cols-2 lg:grid-cols-3">
                    {stageLeads.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        dragOver={false}
                        onDragStart={() => setDragLeadId(lead.id)}
                        onClick={() => onOpen(lead)}
                      />
                    ))}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
