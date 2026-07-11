"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type { Proposal, ProposalStatus, ProposalTemplateKind } from "@/types/proposals";
import { proposalTemplateLabel } from "@/lib/proposal-templates";

const STATUS_STYLES: Record<ProposalStatus, string> = {
  draft: "border-[#c9c2b4] text-charcoal/60",
  sent: "border-sand text-sand",
  accepted: "border-nearblack bg-nearblack text-white",
  closed: "border-red-700/40 text-red-700",
};

const TEMPLATE_KINDS: ProposalTemplateKind[] = ["renovation", "new_build", "multi_phase"];

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

interface Props {
  leadId?: string;
  projectId?: string;
}

/**
 * "Fee proposal" section (BUILD-SPEC.md §"Fee proposal phase (r23)"
 * item 3: "Builder UI on lead detail (+ projects): create from
 * template ... list"). One shared component, mounted from BOTH
 * components/leads/LeadDetailPanel.tsx (leadId) and
 * app/(dashboard)/projects/[id]/invoices/page.tsx (projectId) — exactly
 * one of the two props is passed by each caller, matching
 * proposals.lead_id/project_id's own "at least one set" shape
 * (migration 051's chk_proposals_lead_or_project).
 */
export function ProposalsSection({ leadId, projectId }: Props) {
  const router = useRouter();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [template, setTemplate] = useState<ProposalTemplateKind>("renovation");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = leadId ? `lead_id=${leadId}` : `project_id=${projectId}`;
      const res = await fetch(`/api/proposals?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load fee proposals.");
      setProposals(body.proposals ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load fee proposals.");
    } finally {
      setLoading(false);
    }
  }, [leadId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function createProposal() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId ?? null, project_id: projectId ?? null, template }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not create a fee proposal.");
      router.push(`/proposals/${body.proposal.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a fee proposal.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={template}
          onChange={(e) => setTemplate(e.target.value as ProposalTemplateKind)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        >
          {TEMPLATE_KINDS.map((k) => (
            <option key={k} value={k}>
              {proposalTemplateLabel(k)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={createProposal}
          disabled={creating}
          className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal disabled:opacity-50"
        >
          {creating ? "Creating…" : "New proposal"}
        </button>
      </div>

      {loading ? (
        <p className="text-caption text-charcoal/40">Loading…</p>
      ) : proposals.length === 0 ? (
        <p className="text-caption text-charcoal/40">No fee proposals yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {proposals.map((p) => (
            <li key={p.id} className="flex items-center justify-between border border-[#dcd6cc] px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={clsx("border px-2 py-0.5 text-caption uppercase", STATUS_STYLES[p.status])}>
                  {p.status}
                </span>
                <span className="text-body text-charcoal/70">{formatMoney(p.total_inc)}</span>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`/proposal/${p.token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-caption text-charcoal/50 underline hover:text-nearblack"
                >
                  Preview
                </a>
                <a href={`/proposals/${p.id}`} className="text-caption text-nearblack underline">
                  Edit →
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
