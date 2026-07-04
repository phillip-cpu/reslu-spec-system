"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type {
  CreateLeadInput,
  Lead,
  LeadsAttentionResponse,
  LeadsDashboardSummary,
  LeadStage,
  PatchLeadInput,
} from "@/types";
import { AttentionPanel } from "./AttentionPanel";
import { PipelineDashboard } from "./PipelineDashboard";
import { LeadsBoard } from "./LeadsBoard";
import { LeadsList } from "./LeadsList";
import { AddLeadComposer } from "./AddLeadComposer";
import { LeadDetailPanel } from "./LeadDetailPanel";

type View = "board" | "list";

const EMPTY_ATTENTION: LeadsAttentionResponse = {
  nurture: [],
  stale_proposals: [],
  follow_ups_due: [],
  site_visits_upcoming: [],
};

/**
 * /leads top-level client component. Owns shared `leads` state and
 * toggles between board/list views — same shape as
 * components/items/ProjectWorkspace.tsx's view-segmented-button bar
 * (Spec/Pricing & Procurement/Board), reused here for Board/List.
 *
 * Load order: needs-attention + dashboard summary are fetched
 * alongside the leads list on mount/refresh (three requests in
 * parallel) rather than the dashboard summary being derived purely
 * client-side from `leads` — the avg-days-in-stage calc needs
 * lead_stage_events, which this component does not otherwise hold, so
 * the server-computed `summary` from GET /api/leads?summary=1 is used
 * as-is (see lib/leads.ts buildDashboardSummary, called server-side in
 * app/api/leads/route.ts).
 */
export function LeadsWorkspace() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<LeadsDashboardSummary | null>(null);
  const [attention, setAttention] = useState<LeadsAttentionResponse>(EMPTY_ATTENTION);
  const [view, setView] = useState<View>("board");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = q ? `?summary=1&q=${encodeURIComponent(q)}` : `?summary=1`;
      const [leadsRes, attentionRes] = await Promise.all([
        fetch(`/api/leads${qs}`),
        fetch(`/api/leads/attention`),
      ]);
      const leadsBody = await leadsRes.json();
      if (!leadsRes.ok) throw new Error(leadsBody.error ?? "Could not load leads.");
      setLeads(leadsBody.leads ?? []);
      setSummary(leadsBody.summary ?? null);

      const attentionBody = await attentionRes.json();
      if (attentionRes.ok) setAttention(attentionBody);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load leads.");
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  async function createLead(input: CreateLeadInput) {
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Could not create lead.");
    setLeads((cur) => [body.lead, ...cur]);
    await load();
  }

  async function moveStage(lead: Lead, stage: LeadStage) {
    const prev = leads;
    setLeads((cur) => cur.map((l) => (l.id === lead.id ? { ...l, stage } : l)));
    try {
      const res = await fetch(`/api/leads/${lead.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not move lead.");
      setLeads((cur) => cur.map((l) => (l.id === lead.id ? body.lead : l)));
      if (selectedLead?.id === lead.id) setSelectedLead(body.lead);
      await load();
    } catch (err) {
      setLeads(prev);
      setError(err instanceof Error ? err.message : "Could not move lead.");
    }
  }

  async function patchLead(lead: Lead, patch: PatchLeadInput): Promise<Lead> {
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Could not save lead.");
    setLeads((cur) => cur.map((l) => (l.id === lead.id ? body.lead : l)));
    load();
    return body.lead as Lead;
  }

  async function deleteLead(lead: Lead) {
    if (!confirm(`Delete lead "${lead.surname_project}"?`)) return;
    const prev = leads;
    setLeads((cur) => cur.filter((l) => l.id !== lead.id));
    setSelectedLead(null);
    const res = await fetch(`/api/leads/${lead.id}`, { method: "DELETE" });
    if (!res.ok) {
      setLeads(prev);
      setError("Could not delete lead.");
    } else {
      load();
    }
  }

  async function setFollowUp(lead: Lead, date: string) {
    try {
      await patchLead(lead, { follow_up_date: date });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set follow-up.");
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      <AttentionPanel
        attention={attention}
        onOpen={(lead) => setSelectedLead(lead)}
        onSetFollowUp={setFollowUp}
      />

      {summary && <PipelineDashboard summary={summary} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex border border-[#c9c2b4]">
            {(["board", "list"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={clsx(
                  "px-4 py-2 text-subhead capitalize transition-colors",
                  view === v ? "bg-nearblack text-white" : "text-charcoal hover:bg-nearwhite"
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search leads…"
            className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setComposerOpen((o) => !o)}
          className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal"
        >
          + Add lead
        </button>
      </div>

      {composerOpen && (
        <AddLeadComposer onCreate={createLead} onClose={() => setComposerOpen(false)} />
      )}

      {loading ? (
        <p className="text-body text-charcoal/60">Loading leads…</p>
      ) : view === "board" ? (
        <LeadsBoard leads={leads} onMoveStage={moveStage} onOpen={(lead) => setSelectedLead(lead)} />
      ) : (
        <LeadsList leads={leads} onOpen={(lead) => setSelectedLead(lead)} />
      )}

      {selectedLead && (
        <LeadDetailPanel
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onPatch={(patch) => patchLead(selectedLead, patch)}
          onMoveStage={(stage) => moveStage(selectedLead, stage as LeadStage)}
          onDelete={() => deleteLead(selectedLead)}
          onProjectCreated={(projectId) => {
            setSelectedLead(null);
            router.push(`/projects/${projectId}`);
          }}
        />
      )}
    </div>
  );
}
