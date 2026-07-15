"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  normalizeSidebarOrder,
  projectShortcutLabel,
  visibleSidebarItems,
} from "@/lib/navigation";
import type { HealthPillLevel } from "@/types/health-push";
import type { NavigationPreferencesResponse, RecentProjectShortcut } from "@/types/navigation";

type BadgeCounts = {
  leads_followups: number;
  my_work_due: number;
  health_level: HealthPillLevel;
};

const POLL_MS = 3 * 60 * 1000;

function BadgePill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto flex h-4 min-w-[1rem] shrink-0 items-center justify-center bg-red-700 px-1 text-[10px] font-semibold leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}
function HealthDot({ level }: { level: HealthPillLevel }) {
  const label = level === "green" ? "Healthy" : level === "amber" ? "Needs attention" : "Problem detected";
  return (
    <span
      aria-label={`System health: ${label}`}
      title={`System health: ${label}`}
      className={clsx(
        "h-2.5 w-2.5 shrink-0 border border-white/30",
        level === "green" && "bg-[#4c6b4f]",
        level === "amber" && "bg-[#C9971E]",
        level === "red" && "bg-[#B23A3A]"
      )}
    />
  );
}

/**
 * Dashboard navigation with per-user ordering and deterministic MRU project
 * shortcuts. The three boxes update only when a project is actually visited;
 * they never auto-animate or change beneath the user while idle.
 */
export function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const [badges, setBadges] = useState<BadgeCounts>({
    leads_followups: 0,
    my_work_due: 0,
    health_level: "amber",
  });
  const [sidebarOrder, setSidebarOrder] = useState(() => normalizeSidebarOrder([], isAdmin));
  const [recentProjects, setRecentProjects] = useState<RecentProjectShortcut[]>([]);
  const [arranging, setArranging] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const itemById = useMemo(
    () => new Map(visibleSidebarItems(isAdmin).map((item) => [item.id, item])),
    [isAdmin]
  );
  const orderedItems = sidebarOrder.map((id) => itemById.get(id)).filter(Boolean);

  function closeOnMobile() {
    setOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    const projectMatch = pathname.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/i);
    const request = projectMatch
      ? fetch("/api/navigation-preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visited_project_id: projectMatch[1] }),
        })
      : fetch("/api/navigation-preferences", { cache: "no-store" });

    request
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as NavigationPreferencesResponse;
      })
      .then((body) => {
        if (!body || cancelled) return;
        setSidebarOrder(normalizeSidebarOrder(body.sidebar_order, isAdmin));
        setRecentProjects(body.recent_projects ?? []);
      })
      .catch(() => {
        // Preferences are a convenience; default navigation remains usable.
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, isAdmin]);

  useEffect(() => {
    let cancelled = false;
    async function loadBadges() {
      try {
        const response = await fetch("/api/badges", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const body = await response.json();
        if (cancelled) return;
        setBadges({
          leads_followups: Number(body.leads_followups) || 0,
          my_work_due: Number(body.my_work_due) || 0,
          health_level: ["green", "amber", "red"].includes(body.health_level)
            ? body.health_level
            : "amber",
        });
      } catch {
        // Keep the last-known counts/health when the lightweight poll fails.
      }
    }
    void loadBadges();
    const interval = window.setInterval(loadBadges, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pathname]);

  async function persistOrder(next: string[]) {
    const normalized = normalizeSidebarOrder(next, isAdmin);
    setSidebarOrder(normalized);
    try {
      await fetch("/api/navigation-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebar_order: normalized }),
      });
    } catch {
      // Optimistic order remains for this session; the next load restores the server value.
    }
  }

  function moveItem(id: string, delta: number) {
    const index = sidebarOrder.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= sidebarOrder.length) return;
    const next = [...sidebarOrder];
    [next[index], next[target]] = [next[target], next[index]];
    void persistOrder(next);
  }

  function dropBefore(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    const next = sidebarOrder.filter((id) => id !== draggingId);
    const target = next.indexOf(targetId);
    next.splice(target < 0 ? next.length : target, 0, draggingId);
    setDraggingId(null);
    void persistOrder(next);
  }

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="fixed left-4 top-4 z-50 flex h-11 w-11 items-center justify-center border border-sand bg-nearblack text-white md:hidden"
      >
        {open ? (
          <span aria-hidden className="text-subhead leading-none">✕</span>
        ) : (
          <span aria-hidden className="flex flex-col gap-1">
            <span className="block h-0.5 w-5 bg-white" />
            <span className="block h-0.5 w-5 bg-white" />
            <span className="block h-0.5 w-5 bg-white" />
          </span>
        )}
      </button>

      {open && <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-30 bg-nearblack/50 md:hidden" />}

      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex h-screen w-56 shrink-0 flex-col overflow-y-auto bg-nearblack text-white transition-transform duration-200 ease-out",
          "md:sticky md:top-0 md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="px-6 py-8">
          <Link href="/" aria-label="Back to dashboard" onClick={closeOnMobile}>
            <Image src="/reslu-logo-white.png" alt="RESLU" width={100} height={44} priority className="h-11 w-auto" />
          </Link>
          <p className="label-caps mt-3 text-sand">Spec System</p>
        </div>

        <nav className="flex-1 px-3">
          {orderedItems.map((item, index) => {
            if (!item) return null;
            const active =
              item.id === "projects"
                ? pathname === "/" || pathname.startsWith("/projects/")
                : !item.external && pathname.startsWith(item.href);
            const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;

            return (
              <div
                key={item.id}
                draggable={arranging}
                onDragStart={() => setDraggingId(item.id)}
                onDragOver={(event) => arranging && event.preventDefault()}
                onDrop={() => dropBefore(item.id)}
                className={clsx(
                  "mb-px flex min-h-10 items-center gap-1 transition-colors",
                  active ? "bg-charcoal text-white" : "text-white/70 hover:bg-charcoal/60 hover:text-white",
                  arranging && "cursor-grab border border-white/10"
                )}
              >
                {item.external ? (
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={closeOnMobile}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-subhead"
                  >
                    <span>{item.label}</span><span className="text-white/40">↗</span>
                  </a>
                ) : (
                  <Link
                    href={item.href}
                    onClick={closeOnMobile}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-subhead"
                  >
                    <span className="truncate">{item.label}</span>
                    {item.id === "health" && <HealthDot level={badges.health_level} />}
                    <BadgePill count={badgeCount} />
                  </Link>
                )}

                {item.id === "projects" && !arranging && recentProjects.length > 0 && (
                  <div className="mr-2 flex shrink-0 gap-1" aria-label="Recent projects">
                    {recentProjects.map((project) => (
                      <Link
                        key={project.id}
                        href={`/projects/${project.id}`}
                        title={project.name}
                        aria-label={`Open recent project ${project.name}`}
                        onClick={closeOnMobile}
                        className="flex h-6 w-6 items-center justify-center border border-white/30 bg-white/10 text-[9px] font-semibold text-white hover:border-sand hover:text-sand"
                      >
                        {projectShortcutLabel(project.name)}
                      </Link>
                    ))}
                  </div>
                )}

                {arranging && (
                  <div className="mr-1 flex shrink-0">
                    <button
                      type="button"
                      aria-label={`Move ${item.label} up`}
                      disabled={index === 0}
                      onClick={() => moveItem(item.id, -1)}
                      className="px-1.5 py-2 text-caption text-white/60 hover:text-white disabled:opacity-20"
                    >↑</button>
                    <button
                      type="button"
                      aria-label={`Move ${item.label} down`}
                      disabled={index === orderedItems.length - 1}
                      onClick={() => moveItem(item.id, 1)}
                      className="px-1.5 py-2 text-caption text-white/60 hover:text-white disabled:opacity-20"
                    >↓</button>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-white/10 px-3 py-4">
          <button
            type="button"
            onClick={() => setArranging((value) => !value)}
            className="w-full border border-white/20 px-3 py-2 text-left text-caption text-white/60 hover:border-white/50 hover:text-white"
          >
            {arranging ? "Done arranging" : "Arrange menu"}
          </button>
          <p className="mt-4 px-3 text-caption text-white/30">RESLU Spec System v0.1</p>
        </div>
      </aside>
    </>
  );
}
