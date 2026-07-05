"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const NAV_ITEMS = [
  { label: "Projects", href: "/" },
  // Phase 12a-B — BUILD-SPEC.md §"Phase 12a — My Work": "one page that
  // answers 'what do I do today'". Team-visible (every signed-in user
  // has their own feed; the admin-only lead-follow-ups source is gated
  // inside GET /api/my-work itself, not at this nav/page level).
  { label: "My Work", href: "/my-work" },
  // Phase 13 — BUILD-SPEC.md §"13 Office": global Office board (not
  // per-project) — business housekeeping, department groups. Placed
  // right after My Work (both are "what needs doing" surfaces, above
  // Projects' client-work surfaces) and before Search, mirroring how
  // My Work itself slotted in right after Projects in Phase 12a-B.
  { label: "Office", href: "/office" },
  { label: "Search", href: "/search" },
  { label: "Library", href: "/library" },
  { label: "Address Book", href: "/contacts" },
  // Week 10: admin-only (leads are "admin-only, financial-adjacent"
  // per BUILD-SPEC.md) — filtered out below for non-admins. This is
  // the first NAV_ITEMS entry that needs role-awareness; every prior
  // item here is team-visible.
  { label: "Leads", href: "/leads", adminOnly: true },
  { label: "Settings", href: "/settings" },
];

export function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 bg-nearblack text-white min-h-screen flex flex-col">
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
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "block px-3 py-2.5 text-subhead transition-colors",
                active ? "bg-charcoal text-white" : "text-white/70 hover:text-white hover:bg-charcoal/60"
              )}
            >
              {item.label}
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
