"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const NAV_ITEMS = [
  { label: "Projects", href: "/" },
  { label: "Search", href: "/search" },
  { label: "Library", href: "/library" },
  { label: "Settings", href: "/settings" },
];

export function Sidebar() {
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
        {NAV_ITEMS.map((item) => {
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
