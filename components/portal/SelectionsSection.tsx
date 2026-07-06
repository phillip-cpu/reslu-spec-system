import Link from "next/link";
import type { PortalItemWithFiles } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";

function isOverdue(decisionNeededBy: string | null): boolean {
  if (!decisionNeededBy) return false;
  const today = new Date().toISOString().slice(0, 10);
  return decisionNeededBy < today;
}

function isDueSoon(decisionNeededBy: string | null): boolean {
  if (!decisionNeededBy) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(decisionNeededBy + "T00:00:00");
  const daysUntil = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  return daysUntil >= 0 && daysUntil <= 7;
}

function formatDeadline(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "long" });
}

/**
 * Selections summary card (BUILD-SPEC.md §"Portal selections
 * separation" — Quick items round, 6 July 2026, "stronger cut"):
 *
 *   "The Selections SECTION becomes only a compact summary card:
 *   progress bar, '68 awaiting your decision →', flagged count if any,
 *   deadline warning if any decision_needed_by past/near; links to the
 *   /selections sub-page."
 *
 * This SUPERSEDES the earlier fix-round B version of this component,
 * which still rendered full awaiting/flagged item cards (room groups,
 * expand-to-details, approve/flag, bulk approve, the "Review one by
 * one" stepper) directly on the main portal page — approved items were
 * the only thing that had moved to /portal/[token]/selections. Every
 * bit of that item-level rendering has now moved wholesale to
 * app/portal/[token]/selections/page.tsx (see that page and its new
 * SelectionsWorkspace / AwaitingFlaggedList client components) — this
 * component has ZERO item-level rendering: no thumbnails, no per-item
 * approve/flag, no stepper. It is a pure, server-renderable summary
 * derived from the
 * same `initialItems` the parent page already queries (no extra
 * fetch), linking through to the sub-page for every interactive
 * action.
 *
 * No client state needed any more (this used to be "use client" for
 * its approve/flag/bulk/stepper interactivity) — now a plain server
 * component, consistent with every other summary-only portal section.
 */
export function SelectionsSection({
  token,
  initialItems,
}: {
  token: string;
  initialItems: PortalItemWithFiles[];
}) {
  const total = initialItems.length;
  const approvedCount = initialItems.filter((i) => i.client_approved).length;
  const flaggedCount = initialItems.filter((i) => i.client_flagged).length;
  const awaitingCount = initialItems.filter((i) => !i.client_approved && !i.client_flagged).length;
  const needsDecisionCount = awaitingCount + flaggedCount;

  // Deadline warning — earliest decision_needed_by among items still
  // awaiting a decision (flagged items already have the client's
  // attention, so they don't drive this warning) that's either already
  // past or within the next 7 days. Same amber (soon) / red (overdue)
  // convention as the rest of the portal (e.g. VariationsSection,
  // WhatsNextBlock's deadline framing).
  const upcomingDeadlines = initialItems
    .filter((i) => !i.client_approved && i.decision_needed_by)
    .map((i) => i.decision_needed_by as string)
    .filter((d) => isOverdue(d) || isDueSoon(d))
    .sort();
  const earliestDeadline = upcomingDeadlines[0] ?? null;
  const deadlineOverdue = earliestDeadline ? isOverdue(earliestDeadline) : false;

  if (total === 0) {
    return (
      <PortalSection id="selections" title="Selections">
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">There are no items to review yet. Please check back soon.</p>
        </div>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="selections" title="Selections">
      <Link
        href={`/portal/${token}/selections`}
        className="block border border-[#dcd6cc] bg-nearwhite p-4 transition-colors hover:bg-offwhite sm:p-5"
      >
        {/* Progress bar — approved out of total */}
        <div className="h-1.5 w-full bg-[#e5e0d6]">
          <div
            className="h-1.5 bg-sand"
            style={{ width: `${total > 0 ? Math.round((approvedCount / total) * 100) : 0}%` }}
          />
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-3">
          <p className="text-subhead text-nearblack">
            {needsDecisionCount > 0
              ? `${needsDecisionCount} awaiting your decision →`
              : "You're all caught up →"}
          </p>
          <span className="label-caps shrink-0 !text-charcoal/50">
            {approvedCount} of {total} approved
          </span>
        </div>

        {flaggedCount > 0 && (
          <p className="mt-2 text-body text-red-700">
            {flaggedCount} flagged item{flaggedCount === 1 ? "" : "s"} awaiting a reply from us
          </p>
        )}

        {earliestDeadline && (
          <p className={`mt-2 text-body ${deadlineOverdue ? "text-red-700" : "text-amber-700"}`}>
            {deadlineOverdue
              ? `A decision was due ${formatDeadline(earliestDeadline)} — please review when you can`
              : `Approve by ${formatDeadline(earliestDeadline)} to keep your design package on schedule`}
          </p>
        )}
      </Link>
    </PortalSection>
  );
}
