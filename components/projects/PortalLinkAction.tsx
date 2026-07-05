"use client";

import { useState } from "react";

/**
 * "View client portal" + "Copy link" affordance for the project tab
 * bar — BUILD-SPEC.md §"Housekeeping — 5 July screenshot" point 3:
 * "'View client portal' link in the project tab bar area (right-
 * aligned, external-link icon, opens the token URL in a new tab) ...
 * Sits near a small 'Copy link' affordance (settings keeps the full
 * portal management)." Team-visible (not admin-only) — it's the exact
 * same link the client portal link on the Settings page already
 * displays, just surfaced one click closer from anywhere in the job.
 * A client component only because "Copy link" needs
 * navigator.clipboard; the "View" link itself is a plain anchor.
 */
export function PortalLinkAction({ portalUrl }: { portalUrl: string }) {
  const [copyLabel, setCopyLabel] = useState("Copy link");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopyLabel("Copied");
      setTimeout(() => setCopyLabel("Copy link"), 1500);
    } catch {
      setCopyLabel("Could not copy");
      setTimeout(() => setCopyLabel("Copy link"), 1500);
    }
  }

  return (
    <div className="flex items-center gap-3 py-3 pl-4">
      <a
        href={portalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-caption text-charcoal/60 transition-colors hover:text-nearblack"
      >
        View client portal ↗
      </a>
      <button
        type="button"
        onClick={copyLink}
        className="text-caption text-charcoal/40 transition-colors hover:text-nearblack"
      >
        {copyLabel}
      </button>
    </div>
  );
}
