"use client";

import { useEffect, useRef, useState } from "react";
import type { InviteeOption } from "@/types/phase-small-round";

/**
 * "Add to calendar ▾" — BUILD-SPEC.md "Phillip's ideas list — 6 July
 * 2026" item 2. Shared between the lead detail panel (next to the site
 * visit date) and each client event row — both just point `icsUrl` at
 * their own team-authed GET .ics route
 * (app/api/leads/[id]/calendar.ics or
 * app/api/client-events/[id]/calendar.ics) and pass the same
 * lib/ics.ts googleCalendarUrl() output for the Google option.
 *
 * Deliberately a plain conditionally-rendered absolutely-positioned
 * panel, no popover/menu library — same "simplest thing that works"
 * choice as VisitBottomSheet.tsx and every other small overlay in this
 * codebase. Uses `position: absolute` (anchored to this component's
 * own `relative` wrapper), NOT `fixed` — this menu is meant to hang off
 * its trigger button inline in a scrolling list (e.g. the client events
 * list), and `fixed` positioning inside a scrollable ancestor is
 * exactly the layout trap BUILD-SPEC called out to test for in this
 * round: a `fixed` menu would stay pinned to the viewport instead of
 * tracking the button as the list scrolls. `absolute` + the wrapper's
 * `relative` avoids that entirely. Closes on outside click and Escape.
 */
export function AddToCalendarMenu({
  icsUrl,
  googleUrl,
  invitees,
  selectedInviteeEmails,
  onToggleInvitee,
}: {
  /** GET route that streams the .ics file — download link, no fetch needed. */
  icsUrl: string;
  /** Pre-built Google Calendar "render" URL (lib/ics.ts googleCalendarUrl()) — opens in a new tab. */
  googleUrl: string;
  /** Team roster for the invitee picker — GET /api/profiles. Empty/undefined hides the picker (still fully usable without inviting anyone). */
  invitees?: InviteeOption[];
  selectedInviteeEmails?: string[];
  onToggleInvitee?: (email: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="border border-[#c9c2b4] px-2.5 py-1 text-caption text-charcoal hover:border-nearblack"
      >
        Add to calendar ▾
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 border border-[#dcd6cc] bg-cream p-3 shadow-lg">
          {invitees && invitees.length > 0 && (
            <div className="mb-3">
              <p className="label-caps mb-1.5 !text-charcoal/50">Invite</p>
              <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                {invitees.map((p) => {
                  const checked = (selectedInviteeEmails ?? []).includes(p.email);
                  return (
                    <label key={p.id} className="flex items-center gap-1.5 text-caption text-charcoal/70">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleInvitee?.(p.email)}
                        className="h-3 w-3"
                      />
                      {p.full_name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5 border-t border-[#dcd6cc] pt-2">
            <a
              href={icsUrl}
              download
              onClick={() => setOpen(false)}
              className="border border-nearblack px-3 py-1.5 text-center text-caption text-nearblack hover:bg-nearblack hover:text-white"
            >
              Download .ics
            </a>
            <a
              href={googleUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="border border-[#c9c2b4] px-3 py-1.5 text-center text-caption text-charcoal hover:border-nearblack"
            >
              Open in Google Calendar
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
