import clsx from "clsx";
import { PortalLinkAction } from "./PortalLinkAction";

export type ProjectTabKey =
  | "overview"
  | "ffe"
  | "board"
  | "timeline"
  | "documents"
  | "gallery" // Phase 11B — site photo gallery, see app/(dashboard)/projects/[id]/gallery/
  | "client" // Phase 11B — team-side client area, see app/(dashboard)/projects/[id]/client/
  | "estimate"
  | "invoices"
  | "settings";

interface Props {
  projectId: string;
  active: ProjectTabKey;
  isAdmin: boolean;
  /**
   * Housekeeping (Phase 12a-B) — BUILD-SPEC.md §"Housekeeping — 5 July
   * screenshot" point 3: full portal URL (appUrl + /portal/{client_token}).
   * Optional — every existing caller of this component keeps working
   * unchanged; pages that don't pass it simply don't render the "View
   * client portal" affordance (rather than making every one of this
   * component's ten call sites fetch the token immediately).
   */
  portalUrl?: string;
}

/**
 * Persistent tab bar for the project overview hub (BUILD-SPEC.md
 * "Project overview hub": "Overview | FF&E | Documents | Estimate |
 * Invoices | Settings; financial tabs admin-only"). Deliberately plain
 * styled links, not client-side tab state — per the build spec's own
 * steer ("'tabs' may be styled links, simplest and best"): FF&E,
 * Documents, Estimate, Invoices and Settings are all separate routes
 * already (this keeps every existing deep link working unchanged),
 * Overview is the index route itself. Estimate/Invoices are omitted
 * entirely for non-admins — same "hidden, not merely disabled"
 * pattern as the old header's admin-gated Invoices link, and the
 * routes themselves independently re-check admin server-side.
 *
 * Week 9 additions: Board (kanban — project task board + procurement
 * lens, BUILD-SPEC.md "Week 9 — detailed scope" §2/§3) and Timeline
 * (Gantt, §4) — both team-visible (no financial data), so neither is
 * adminOnly, same trust tier as Documents.
 */
export function ProjectTabs({ projectId, active, isAdmin, portalUrl }: Props) {
  const tabs: { key: ProjectTabKey; label: string; href: string; adminOnly?: boolean }[] = [
    { key: "overview", label: "Overview", href: `/projects/${projectId}` },
    { key: "ffe", label: "FF&E", href: `/projects/${projectId}?tab=ffe` },
    { key: "board", label: "Board", href: `/projects/${projectId}/board` },
    { key: "timeline", label: "Timeline", href: `/projects/${projectId}/timeline` },
    { key: "documents", label: "Documents", href: `/projects/${projectId}/documents` },
    { key: "gallery", label: "Gallery", href: `/projects/${projectId}/gallery` },
    { key: "client", label: "Client area", href: `/projects/${projectId}/client` },
    { key: "estimate", label: "Estimate", href: `/projects/${projectId}/estimate`, adminOnly: true },
    { key: "invoices", label: "Invoices", href: `/projects/${projectId}/invoices`, adminOnly: true },
    { key: "settings", label: "Settings", href: `/projects/${projectId}/settings` },
  ];

  return (
    <nav className="flex items-center justify-between border-b border-[#dcd6cc] bg-cream px-8">
      <div className="flex">
        {tabs
          .filter((t) => !t.adminOnly || isAdmin)
          .map((t) => (
            <a
              key={t.key}
              href={t.href}
              className={clsx(
                "border-b-2 px-4 py-3 text-subhead transition-colors",
                active === t.key
                  ? "border-nearblack text-nearblack"
                  : "border-transparent text-charcoal/60 hover:text-nearblack"
              )}
            >
              {t.label}
            </a>
          ))}
      </div>
      {portalUrl && <PortalLinkAction portalUrl={portalUrl} />}
    </nav>
  );
}
