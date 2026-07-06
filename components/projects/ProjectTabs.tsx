"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import Link from "next/link";
import { PortalLinkAction } from "./PortalLinkAction";

export type ProjectTabKey =
  | "overview"
  | "design" // Phase 12b — Design Framework, see app/(dashboard)/projects/[id]/design/
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
 * Invoices | Settings; financial tabs admin-only"). FF&E, Documents,
 * Estimate, Invoices and Settings are all separate routes already
 * (this keeps every existing deep link working unchanged), Overview is
 * the index route itself. Estimate/Invoices are omitted entirely for
 * non-admins — same "hidden, not merely disabled" pattern as the old
 * header's admin-gated Invoices link, and the routes themselves
 * independently re-check admin server-side.
 *
 * Week 9 additions: Board (kanban — project task board + procurement
 * lens, BUILD-SPEC.md "Week 9 — detailed scope" §2/§3) and Timeline
 * (Gantt, §4) — both team-visible (no financial data), so neither is
 * adminOnly, same trust tier as Documents.
 *
 * Phase 12b addition: Design — the Design Framework tab (BUILD-SPEC.md
 * §"12b Design Framework"), placed between Overview and FF&E per this
 * task's brief. Team-visible, not adminOnly (design work carries no
 * pricing/financial data at all — see app/api/design-tasks/route.ts's
 * own "no pricing" verification note).
 *
 * Round A "Tab bar polish" — this component moved from a plain server-
 * rendered `<nav>` of `next/link`s to a client component so it can
 * render a single sliding underline indicator (an absolutely-positioned
 * span, animated via transform/width transitions) instead of every
 * tab drawing its own static `border-b-2`. Every existing call site
 * (11 as of this round — every project sub-page) already passes only
 * plain strings/booleans (`projectId`, `active`, `isAdmin`,
 * `portalUrl`), all of which cross the server/client boundary as props
 * exactly the same as before; nothing else about how this component is
 * consumed changes. `PortalLinkAction` was already its own "use client"
 * component rendered as a child here, so nesting it inside this newly
 * client `ProjectTabs` needs no change to that file either.
 *
 * No sticky wrapper: this bar renders directly after `<Header>` in
 * normal document flow on every call site (verified across all 11
 * pages) — there is no `position: sticky` ancestor for it to hang off,
 * so per this round's brief this implementation does NOT add
 * `position: sticky`/backdrop-blur to try to manufacture that effect;
 * the polish here is scoped to the underline + hover/label-weight
 * treatment only.
 */
export function ProjectTabs({ projectId, active, isAdmin, portalUrl }: Props) {
  const tabs: { key: ProjectTabKey; label: string; href: string; adminOnly?: boolean }[] = [
    { key: "overview", label: "Overview", href: `/projects/${projectId}` },
    { key: "design", label: "Design", href: `/projects/${projectId}/design` },
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

  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  const tabRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  /**
   * Measures the active tab's own offsetLeft/offsetWidth relative to
   * the flex row that contains every tab (containerRef), on mount,
   * whenever `active` changes, and on container resize (a narrow
   * viewport can wrap/resize the row, e.g. the admin-only tabs
   * appearing/disappearing, or a browser window resize) — a
   * ResizeObserver on the container catches all of these without
   * needing a separate window-resize listener.
   */
  useEffect(() => {
    function measure() {
      const el = tabRefs.current.get(active);
      if (!el) {
        setIndicator(null);
        return;
      }
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    }
    measure();

    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [active]);

  return (
    <nav className="flex items-center justify-between border-b border-[#dcd6cc] bg-cream px-8">
      <div ref={containerRef} className="relative flex">
        {visibleTabs.map((t) => (
          <Link
            key={t.key}
            ref={(el) => {
              if (el) tabRefs.current.set(t.key, el);
              else tabRefs.current.delete(t.key);
            }}
            href={t.href}
            prefetch={true}
            className={clsx(
              "px-4 py-3 text-subhead text-charcoal/60 transition-colors duration-150 hover:text-nearblack",
              active === t.key && "font-medium text-nearblack"
            )}
          >
            {t.label}
          </Link>
        ))}

        {/* Sliding underline — a single absolutely-positioned indicator
            instead of each tab drawing its own static border, per this
            round's "Tab bar polish" brief. transform: translateX (not
            `left`) so the move is GPU-composited; width animates
            alongside it so tabs of different label lengths (e.g.
            "Overview" -> "Client area") don't jump. Renders nothing
            until the first measurement resolves (indicator === null),
            avoiding a flash at column 0 before layout is known. */}
        {indicator && (
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-nearblack transition-[transform,width] duration-200 ease-out"
            style={{
              width: `${indicator.width}px`,
              transform: `translateX(${indicator.left}px)`,
            }}
          />
        )}
      </div>
      {portalUrl && <PortalLinkAction portalUrl={portalUrl} />}
    </nav>
  );
}
