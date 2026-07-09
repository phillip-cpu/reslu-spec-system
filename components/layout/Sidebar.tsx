"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const NAV_ITEMS = [
  { label: "My Work", href: "/my-work", badgeKey: "my_work_due" as const },
  { label: "Projects", href: "/" },
  // Phase 12a-B — BUILD-SPEC.md §"Phase 12a — My Work": "one page that
  // answers 'what do I do today'". Team-visible (every signed-in user
  // has their own feed; the admin-only lead-follow-ups source is gated
  // inside GET /api/my-work itself, not at this nav/page level).
  // Fix round B: carries a badge key ("my_work_due") — see
  // BUILD-SPEC.md §"Sidebar notification badges".
  // Phase 13 — BUILD-SPEC.md §"13 Office": global Office board (not
  // per-project) — business housekeeping, department groups. Placed
  // right after My Work (both are "what needs doing" surfaces, above
  // Projects' client-work surfaces) and before Search, mirroring how
  // My Work itself slotted in right after Projects in Phase 12a-B.
  { label: "Office", href: "/office" },
  { label: "Search", href: "/search" },
  { label: "Library", href: "/library" },
  // CPD tracker round — BUILD-SPEC.md "CPD point tracker". Team-visible
  // (every signed-in user tracks their own CPD entries; the admin-only
  // "All team" view is gated inside the page/API, not here — same
  // pattern as My Work's admin-only sources). Placed between Library
  // and Address Book per this round's own placement judgement call —
  // both neighbours are reference/directory-style pages rather than
  // "what needs doing" surfaces (My Work/Office), so a personal
  // record-keeping page reads naturally in this cluster.
  { label: "CPD", href: "/cpd" },
  { label: "Address Book", href: "/contacts" },
  // Week 10: admin-only (leads are "admin-only, financial-adjacent"
  // per BUILD-SPEC.md) — filtered out below for non-admins. This is
  // the first NAV_ITEMS entry that needs role-awareness; every prior
  // item here is team-visible. Fix round B: badge key "leads_followups"
  // (also admin-gated server-side — GET /api/badges returns 0 for
  // non-admins regardless, this is belt-and-braces with the nav filter).
  { label: "Leads", href: "/leads", adminOnly: true, badgeKey: "leads_followups" as const },
  { label: "Settings", href: "/settings" },
  // Phillip 8 Jul: external link to the RESLU journal/blog CMS (Sanity
  // Studio). Renders as a plain <a target="_blank"> below — external
  // items never match pathname-active logic and carry no badge.
  {
    label: "Blog",
    href: "https://www.sanity.io/@owfkpTTv2/studio/ugc40fkuw499wo2h5ljfl4ir/default/structure/journal;F9yzAmOGUc9wBOLNgbeWAB",
    external: true as const,
  },
];

type BadgeCounts = { leads_followups: number; my_work_due: number };

const POLL_MS = 3 * 60 * 1000; // ~3 min, per BUILD-SPEC.md §"Sidebar notification badges"

/**
 * Small red count pill — hidden entirely at 0 (BUILD-SPEC.md: "Zero
 * when none (badge hidden)"). Sharp corners, no border-radius, per the
 * brand guide.
 */
function BadgePill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto flex h-4 min-w-[1rem] shrink-0 items-center justify-center bg-red-700 px-1 text-[10px] font-semibold leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Fix round B — BUILD-SPEC.md §"Sidebar notification badges": "Sidebar
 * entries gain count badges (small red pill, right-aligned): Leads =
 * follow-ups due count (admin only); My Work = my items due today +
 * overdue. Lightweight GET /api/badges endpoint returning both counts
 * in one call; sidebar polls every ~3 min + refreshes on navigation."
 *
 * Sidebar was already a client component (usePathname), so the badge
 * state/polling lives directly in it rather than needing a separate
 * client subcomponent wrapper.
 */
export function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const [badges, setBadges] = useState<BadgeCounts>({ leads_followups: 0, my_work_due: 0 });

  useEffect(() => {
    let cancelled = false;

    async function loadBadges() {
      try {
        const res = await fetch("/api/badges");
        if (!res.ok || cancelled) return;
        const body = await res.json();
        if (cancelled) return;
        setBadges({
          leads_followups: Number(body.leads_followups) || 0,
          my_work_due: Number(body.my_work_due) || 0,
        });
      } catch {
        // Non-fatal — badges just stay at their last known value.
      }
    }

    loadBadges();
    const interval = setInterval(loadBadges, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Refreshes on every route change (pathname dependency) in addition
    // to the ~3 min poll, per the build spec.
  }, [pathname]);

  return (
    <aside className="w-56 shrink-0 bg-nearblack text-white flex flex-col sticky top-0 h-screen overflow-y-auto">
      <div className="px-6 py-8">
        <Link href="/" aria-label="Back to dashboard">
          <Image
            src="/reslu-logo-white.png"
            alt="RESLU"
            width={100}
            height={44}
            priority
            className="h-11 w-auto"
          />
        </Link>
        <p className="label-caps mt-3 text-sand">Spec System</p>
      </div>

      <nav className="flex-1 px-3">
        {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
          if ("external" in item && item.external) {
            return (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2.5 text-subhead text-white/70 transition-colors hover:text-white hover:bg-charcoal/60"
              >
                <span>{item.label}</span>
                <span className="text-white/40">↗</span>
              </a>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-2 px-3 py-2.5 text-subhead transition-colors",
                active ? "bg-charcoal text-white" : "text-white/70 hover:text-white hover:bg-charcoal/60"
              )}
            >
              <span>{item.label}</span>
              <BadgePill count={badgeCount} />
            </Link>
          );
        })}
      </nav>

      <div className="px-6 py-6 text-caption text-white/40">
        RESLU Spec System v0.1
      </div>
    </aside>
  );
}
