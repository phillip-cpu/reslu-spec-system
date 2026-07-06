"use client";

import Link from "next/link";

/**
 * Sticky anchor nav for the sectioned portal (BUILD-SPEC.md "Week 8 —
 * Client portal expansion": "the portal becomes sectioned (anchor nav
 * or stacked sections, mobile-first)"). Plain in-page anchors — no
 * router involved, no client-side section state to keep in sync with
 * SSR'd content below.
 *
 * Phase 11B renames: "Schedule" -> "Selections" (the FF&E approvals
 * section, restyled at scale — BUILD-SPEC.md §"Selections (FF&E
 * approvals)"), "Updates" -> "Diary" (magazine-style journal entries),
 * and adds "Handover" (only shown once the project is completed — see
 * app/portal/[token]/page.tsx's `visible.handover` flag).
 *
 * Fix round B — BUILD-SPEC.md §"Portal selections separation": "reached
 * via a compact link card on the main page ... and the portal nav."
 * "Your selections" is a REAL page link (/portal/[token]/selections),
 * not an in-page anchor like every other entry here — it's rendered
 * with next/link instead of a bare <a href="#...">, and only shown when
 * `approvedCount` is passed in and > 0 (no point linking to an empty
 * gallery). Optional so every existing call site (which doesn't pass
 * it) keeps compiling unchanged.
 */

const SECTIONS = [
  { id: "selections", label: "Selections" },
  { id: "timeline", label: "Timeline" },
  { id: "diary", label: "Diary" },
  { id: "documents", label: "Documents" },
  { id: "contracts", label: "Contracts" },
  { id: "variations", label: "Variations" },
  { id: "photos", label: "Progress" },
  { id: "handover", label: "Handover" },
] as const;

export function PortalNav({
  visible,
  token,
  approvedCount,
}: {
  visible: Record<string, boolean>;
  token?: string;
  approvedCount?: number;
}) {
  const sections = SECTIONS.filter((s) => visible[s.id] !== false);
  const showYourSelections = !!token && (approvedCount ?? 0) > 0;
  if (sections.length === 0 && !showYourSelections) return null;

  return (
    <nav className="sticky top-0 z-10 -mx-6 border-b border-[#dcd6cc] bg-cream/95 px-6 backdrop-blur sm:mx-0">
      <div className="mx-auto flex max-w-4xl gap-5 overflow-x-auto py-3 text-caption">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="label-caps whitespace-nowrap !text-charcoal/60 transition-colors hover:!text-nearblack"
          >
            {s.label}
          </a>
        ))}
        {showYourSelections && (
          <Link
            href={`/portal/${token}/selections`}
            className="label-caps whitespace-nowrap !text-sand transition-colors hover:!text-nearblack"
          >
            Your selections
          </Link>
        )}
      </div>
    </nav>
  );
}
