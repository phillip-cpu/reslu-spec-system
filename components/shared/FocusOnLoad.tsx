"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * My Work deep-link focus (BUILD-SPEC.md "Three from Phillip — 6 July
 * 2026 evening" item 1): "My Work links gain ?focus=<kind>-<id>; target
 * pages render items with matching DOM ids; a shared FocusOnLoad client
 * helper scrolls the element into view ({block:'center'}) + 2s sand
 * outline pulse, then cleans the param. Focus param takes precedence
 * over ScrollMemory restore."
 *
 * Mount this once on any page that renders one of My Work's linked
 * surfaces (board tasks, office tasks, diary drafts, trade proposals,
 * design tasks — register/P&P per docs/HANDOFF-focus-register.md).
 * Each target row/card needs a matching `id={`focus-<kind>-<id>`}`
 * attribute — see lib/my-work.ts / app/api/my-work/route.ts for the
 * exact `kind` values used to build that id.
 *
 * Style precedent: components/shared/ScrollMemory.tsx (same 'use
 * client' + useSearchParams shape, returns null). This component reads
 * `?focus=` directly rather than sharing ScrollMemory's sessionStorage
 * key — the two are coordinated by ScrollMemory itself skipping its
 * own restore when `?focus=` is present (see that file's edit), so
 * "focus must win" is enforced at the ScrollMemory end, not here.
 */
export function FocusOnLoad() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focus = searchParams.get("focus");

  useEffect(() => {
    if (!focus) return;

    const id = `focus-${focus}`;
    const el = document.getElementById(id);

    // Timer/rAF handles are hoisted to this outer scope (rather than
    // declared inside the nested rAF callbacks) so the effect's own
    // cleanup function — returned directly from this useEffect, not
    // from a callback nested inside it — can actually cancel them.
    // React only registers a cleanup function returned from the effect
    // callback itself; a `return` inside a requestAnimationFrame/
    // setTimeout callback is just that callback's own return value and
    // is silently discarded, never wired up as this effect's teardown.
    let raf1 = 0;
    let raf2 = 0;
    let pulseTimer = 0;
    let transitionResetTimer = 0;

    if (el) {
      // Double rAF: let the page finish its own paint (and any
      // ScrollMemory effect that already ran and no-opped due to the
      // focus param) before measuring/scrolling — same "two frames"
      // reasoning ScrollMemory's own restore uses.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          el.scrollIntoView({ block: "center", behavior: "smooth" });

          const previousTransition = el.style.transition;
          const previousOutline = el.style.outline;
          const previousOutlineOffset = el.style.outlineOffset;

          el.style.transition = "outline-color 0.3s ease, outline-offset 0.3s ease";
          el.style.outline = "2px solid #A08C72";
          el.style.outlineOffset = "2px";

          pulseTimer = window.setTimeout(() => {
            el.style.outline = previousOutline || "2px solid transparent";
            el.style.outlineOffset = previousOutlineOffset || "0px";
            transitionResetTimer = window.setTimeout(() => {
              el.style.transition = previousTransition;
            }, 300);
          }, 2000);
        });
      });
    }

    // Strip the focus param but preserve every other query param —
    // router.replace so this doesn't add a back-button entry.
    const next = new URLSearchParams(searchParams.toString());
    next.delete("focus");
    const nextQuery = next.toString();
    const url = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    router.replace(url, { scroll: false });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(pulseTimer);
      window.clearTimeout(transitionResetTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return null;
}
