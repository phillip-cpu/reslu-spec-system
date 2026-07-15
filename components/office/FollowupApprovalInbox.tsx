"use client";

import { useState } from "react";
import type { AriaFollowupDraft } from "@/types/aria-followups";

interface Props {
  initialDrafts: AriaFollowupDraft[];
}

/**
 * Human approval surface for Aria-prepared lead emails. The approve
 * button is deliberately explicit: it authorises Aria to send the exact
 * displayed copy once. Merely viewing or editing Office never sends.
 */
export function FollowupApprovalInbox({ initialDrafts }: Props) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/aria-followups/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not update this draft");
      setDrafts((current) => current.filter((draft) => draft.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this draft");
    } finally {
      setBusyId(null);
    }
  }

  if (drafts.length === 0) return null;

  return (
    <section className="mb-8 border border-sand/60 bg-[#faf6ec] p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="label-caps !text-sand">Aria approvals</p>
          <h2 className="font-serif text-2xl text-nearblack">Lead follow-ups ready to review</h2>
        </div>
        <p className="text-caption text-charcoal/50">
          Nothing sends until you choose “Approve &amp; send”.
        </p>
      </div>

      {error && (
        <p className="mb-3 border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">
          {error}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {drafts.map((draft) => {
          const leadName =
            [draft.lead?.first_name, draft.lead?.surname_project]
              .filter(Boolean)
              .join(" ") || "Lead";
          const busy = busyId === draft.id;
          return (
            <article key={draft.id} className="border border-[#d8d0c2] bg-cream p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="label-caps !text-charcoal/50">{leadName}</p>
                  <p className="text-caption text-charcoal/50">To {draft.recipient_email}</p>
                </div>
                <span className="border border-amber-700/30 bg-amber-50 px-2 py-1 text-caption text-amber-800">
                  Needs approval
                </span>
              </div>
              <p className="mb-2 text-subhead text-nearblack">{draft.subject}</p>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 border-sand/50 pl-3 text-body text-charcoal">
                {draft.body}
              </div>
              {draft.context_summary && (
                <p className="mt-3 text-caption text-charcoal/50">
                  Aria checked: {draft.context_summary}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(draft.id, "approve")}
                  className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal disabled:opacity-50"
                >
                  {busy ? "Working…" : "Approve & send"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(draft.id, "reject")}
                  className="border border-[#c9c2b4] px-4 py-2 text-caption text-charcoal hover:border-nearblack disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
