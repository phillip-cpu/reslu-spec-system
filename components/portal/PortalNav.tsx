"use client";

import Link from "next/link";

/**
 * Sticky anchor nav for the sectioned portal (BUILD-SPEC.md "Week 8 —
 * Client portal expansion": "the portal becomes sectioned (anchor nav
 * or stacked sections, mobile-first)"). Plain in-page anchors for
 * every SSR'd section still on the main page — no router involved, no
 * client-side section state to keep in sync.
 *
 * Phase 11B renames: "Schedule" -> "Selections" (the FF&E approvals
 * section, restyled at scale — BUILD-SPEC.md §"Selections (FF&E
 * approvals)"), "Updates" -> "Diary" (magazine-style journal entries),
 * and adds "Handover" (only shown once the project is completed — see
 * app/portal/[token]/page.tsx's `visible.handover` flag).
 *
 * Quick items round (6 July 2026) — BUILD-SPEC.md §"Portal selections
 * separation" (stronger cut): "PortalNav 'Selections' anchor becomes a
 * link to the sub-page." The main portal page no longer has a
 * `#selections` section with any item content to scroll to (it's now
 * just a compact summary card — see SelectionsSection.tsx) — an
 * in-page anchor there would land on an empty-feeling card, so
 * "Selections" is now ALWAYS a real page link
 * (/portal/[token]/selections, `next/link`) rather than a `#selections`
 * anchor, and is dropped from the `SECTIONS` anchor list entirely.
 * `token` is required for this reason (every caller already has it —
 * app/portal/[token]/page.tsx passes it down as before). This
 * supersedes the fix round's earlier "Your selections" link, which was
 * a SEPARATE nav entry gated behind `approvedCount > 0` — now there's
 * just the one "Selections" entry, shown unconditionally (there's
 * always something to review on the sub-page, even before anything's
 * been approved).
 */

const SECTIONS = [
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
}: {
  visible: Record<string, boolean>;
  token: string;
}) {
  const sections = SECTIONS.filter((s) => visible[s.id] !== false);

  return (
    <nav className="sticky top-0 z-10 -mx-6 border-b border-[#dcd6cc] bg-cream/95 px-6 backdrop-blur sm:mx-0">
      <div className="mx-auto flex max-w-4xl gap-5 overflow-x-auto py-3 text-caption">
        <Link
          href={`/portal/${token}/selections`}
          className="label-caps whitespace-nowrap !text-charcoal/60 transition-colors hover:!text-nearblack"
        >
          Selections
        </Link>
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="label-caps whitespace-nowrap !text-charcoal/60 transition-colors hover:!text-nearblack"
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
