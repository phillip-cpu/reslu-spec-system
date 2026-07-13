"use client";

import { useEffect, useState } from "react";
import type { ProjectAttentionResponse } from "@/types/order-by";

/**
 * QA fix round (r27) item 12 — "wire the dead attention aggregator":
 * GET /api/projects/[id]/attention (ordering_due + missing_lead_times)
 * had zero callers anywhere in the app before this round. This is the
 * board half of the fix — a small, dismissible brand chip at the top
 * of the board surfacing BOTH groups for THIS project (the My Work
 * half, source #13, lives in app/api/my-work/route.ts +
 * components/my-work/MyWorkWorkspace.tsx's KIND_LABEL — see that
 * kind's own comment for why ordering_due isn't ALSO re-derived
 * there).
 *
 * Admin-only data (the route itself 403s a non-admin, same P&P/
 * procurement-sensitive gating as GET /api/projects/[id]/order-by) — a
 * non-admin's fetch simply fails quietly and the banner renders
 * nothing, same "fail quiet, this is a convenience surface" posture as
 * components/proposals/ProposalEditor.tsx's BriefAnswersReference.
 *
 * Dismiss is session-only (component state, not persisted) — a
 * deliberately lightweight "I've seen this, stop nagging me for this
 * viewing" rather than a stored per-user preference; the underlying
 * items are already durably actionable from the P&P tab this chip
 * links to, so nothing is lost by a reload bringing it back.
 */
export function AttentionBanner({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectAttentionResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/attention`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (dismissed || !data) return null;

  const orderingCount = data.ordering_due.length;
  const missingCount = data.missing_lead_times.count;
  if (orderingCount === 0 && missingCount === 0) return null;

  const parts: string[] = [];
  if (orderingCount > 0) {
    parts.push(`${orderingCount} item${orderingCount === 1 ? "" : "s"} due to order`);
  }
  if (missingCount > 0) {
    parts.push(`${missingCount} missing a lead time`);
  }

  const href =
    orderingCount > 0
      ? `/projects/${projectId}?tab=ffe&focus=ordering_due-${data.ordering_due[0].item_id}`
      : data.missing_lead_times.href;

  return (
    <div className="flex items-center justify-between gap-3 border border-sand bg-cream px-3 py-2">
      <a href={href} className="text-body text-nearblack underline decoration-sand hover:decoration-nearblack">
        {parts.join(" · ")}
      </a>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 text-caption text-charcoal/50 hover:text-nearblack"
      >
        Dismiss
      </button>
    </div>
  );
}
