"use client";

import clsx from "clsx";
import Link from "next/link";
import { PortalLinkAction } from "./PortalLinkAction";

export type ProjectTabKey =
  | "overview"
  | "design"
  | "ffe"
  | "board"
  | "timeline"
  | "documents"
  | "gallery"
  | "diary"
  | "client"
  | "estimate"
  | "invoices"
  | "settings";

interface Props {
  projectId: string;
  active: ProjectTabKey;
  isAdmin: boolean;
  portalUrl?: string;
}
type ProjectNavGroup = "work" | "site" | "finance";

const GROUP_FOR_TAB: Partial<Record<ProjectTabKey, ProjectNavGroup>> = {
  design: "work",
  ffe: "work",
  board: "work",
  timeline: "work",
  gallery: "site",
  diary: "site",
  estimate: "finance",
  invoices: "finance",
};

/**
 * Two-level project navigation: seven stable destinations replace the old
 * twelve-link strip, while the active group's focused sub-navigation appears
 * immediately beneath it. Existing URLs and permission gates stay unchanged.
 */
export function ProjectTabs({ projectId, active, isAdmin, portalUrl }: Props) {
  const activeGroup = GROUP_FOR_TAB[active] ?? null;
  const primary = [
    { key: "overview", label: "Overview", href: `/projects/${projectId}`, active: active === "overview" },
    { key: "work", label: "Work", href: `/projects/${projectId}/board`, active: activeGroup === "work" },
    { key: "documents", label: "Documents", href: `/projects/${projectId}/documents`, active: active === "documents" },
    { key: "site", label: "Site", href: `/projects/${projectId}/diary`, active: activeGroup === "site" },
    { key: "client", label: "Client", href: `/projects/${projectId}/client`, active: active === "client" },
    ...(isAdmin
      ? [{ key: "finance", label: "Finance", href: `/projects/${projectId}/estimate`, active: activeGroup === "finance" }]
      : []),
    { key: "settings", label: "Settings", href: `/projects/${projectId}/settings`, active: active === "settings" },
  ];

  const childGroups: Record<ProjectNavGroup, { key: ProjectTabKey; label: string; href: string }[]> = {
    work: [
      { key: "design", label: "Design", href: `/projects/${projectId}/design` },
      { key: "ffe", label: "FF&E", href: `/projects/${projectId}?tab=ffe` },
      { key: "board", label: "Board", href: `/projects/${projectId}/board` },
      { key: "timeline", label: "Timeline", href: `/projects/${projectId}/timeline` },
    ],
    site: [
      { key: "diary", label: "Site diary", href: `/projects/${projectId}/diary` },
      { key: "gallery", label: "Gallery", href: `/projects/${projectId}/gallery` },
    ],
    finance: [
      { key: "estimate", label: "Estimate", href: `/projects/${projectId}/estimate` },
      { key: "invoices", label: "Invoices", href: `/projects/${projectId}/invoices` },
    ],
  };

  return (
    <nav className="border-b border-[#dcd6cc] bg-cream" aria-label="Project navigation">
      <div className="flex items-center justify-between gap-3 px-4 md:px-8">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {primary.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              prefetch
              className={clsx(
                "shrink-0 border-b-2 px-3 py-3 text-subhead transition-colors md:px-4",
                item.active
                  ? "border-nearblack font-medium text-nearblack"
                  : "border-transparent text-charcoal/60 hover:text-nearblack"
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
        {portalUrl && <PortalLinkAction portalUrl={portalUrl} />}
      </div>

      {activeGroup && (activeGroup !== "finance" || isAdmin) && (
        <div className="flex overflow-x-auto border-t border-[#e5e0d6] bg-offwhite px-4 md:px-8">
          {childGroups[activeGroup].map((item) => (
            <Link
              key={item.key}
              href={item.href}
              prefetch
              className={clsx(
                "shrink-0 border-b-2 px-3 py-2 text-caption transition-colors",
                active === item.key
                  ? "border-sand font-medium text-nearblack"
                  : "border-transparent text-charcoal/55 hover:text-nearblack"
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
