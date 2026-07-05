"use client";

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

export function PortalNav({ visible }: { visible: Record<string, boolean> }) {
  const sections = SECTIONS.filter((s) => visible[s.id] !== false);
  if (sections.length === 0) return null;

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
      </div>
    </nav>
  );
}
