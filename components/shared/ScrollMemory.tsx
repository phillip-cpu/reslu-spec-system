"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Per-route scroll memory (Phillip, 6 Jul: "pages reset every time I go
 * back and forth" between project tabs). Records scrollY per full path
 * (pathname + search, since FF&E lives at ?tab=ffe) in sessionStorage
 * and restores it when that path is revisited within the session.
 * Session-scoped by design: a fresh visit tomorrow starts at the top.
 * Mounted once in the dashboard layout; portal deliberately excluded
 * (clients should always land at the top of their page).
 *
 * "Three from Phillip — 6 July 2026 evening" item 1: "Focus param takes
 * precedence over ScrollMemory restore." When `?focus=` is present,
 * this effect skips BOTH the restore-on-mount AND the key computation
 * uses the raw search string as before (so scroll position keyed on a
 * ?focus= URL is never itself saved/read back — that URL is transient
 * and gets stripped by FocusOnLoad within a couple of frames anyway).
 * Simplest coordination point: FocusOnLoad.tsx owns the actual
 * scroll-to-element + outline pulse; this file only needs to get out
 * of its way.
 */
export function ScrollMemory() {
  const pathname = usePathname();
  const search = useSearchParams();
  const hasFocusParam = search.has("focus");
  const key = `reslu-scroll:${pathname}?${search.toString()}`;

  useEffect(() => {
    if (hasFocusParam) {
      // A focus deep-link owns this load — FocusOnLoad.tsx will scroll
      // to the target element itself. Don't restore a stale saved
      // position out from under it, and don't attach the scroll
      // listener against this transient ?focus= URL either (it's about
      // to be stripped via router.replace, which will re-run this
      // effect with the param gone and resume normal tracking then).
      return;
    }

    const saved = sessionStorage.getItem(key);
    if (saved) {
      const y = Number(saved);
      if (Number.isFinite(y) && y > 0) {
        // Two frames: let the page paint before restoring, or long
        // lists restore to a shorter-than-final document and clamp.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.scrollTo(0, y))
        );
      }
    }
    const onScroll = () => {
      sessionStorage.setItem(key, String(window.scrollY));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [key, hasFocusParam]);

  return null;
}
