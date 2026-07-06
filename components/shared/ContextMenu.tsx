"use client";

import { useEffect, useRef } from "react";

/**
 * Generic right-click (and long-press, on touch) context menu — Round A
 * "Board owns dates, Timeline is the visual" §"right-click menu".
 * Deliberately a plain fixed-position panel, no popover/menu library —
 * same "simplest thing that works" convention this codebase already
 * uses for every other small overlay (see AddToCalendarMenu.tsx,
 * VisitBottomSheet.tsx). Positioned with `position: fixed` at the exact
 * pointer/long-press coordinates the caller captured on
 * contextmenu/long-press — unlike AddToCalendarMenu's anchored
 * `absolute` panel, a context menu is summoned at an arbitrary point
 * anywhere in a scrollable grid (the Gantt week grid), so `fixed`
 * coordinates from the triggering event are the correct approach here.
 *
 * Closes on: Escape, click-away (mousedown outside), and scroll of any
 * ancestor (a menu that stays glued to the screen while its anchor
 * point scrolls away underneath it would point at the wrong row/date).
 *
 * A submenu (used for "Change colour") is just another `items` entry
 * with its own nested `items` array — rendered as a flyout on hover/tap
 * of that row, recursing through this exact same component.
 */
export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Nested items render this row as a flyout submenu instead of a clickable action. */
  items?: ContextMenuItem[];
  /** Small swatch rendered before the label — used by the colour submenu. */
  swatch?: string;
  /** Visually separates this row from the one above with a top border. */
  separatorBefore?: boolean;
}

export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function handleScroll() {
      onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    // capture:true so this fires for scroll on ANY ancestor scroll
    // container, not just window (the Gantt grid's own
    // overflow-x-auto wrapper is the one that actually scrolls).
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  // Clamp so the menu never renders off the right/bottom edge of the
  // viewport — a fixed-width estimate (200px/menu-item-count*32) is
  // good enough here since this isn't measured post-render.
  const maxLeft = typeof window !== "undefined" ? window.innerWidth - 220 : position.x;
  const maxTop = typeof window !== "undefined" ? window.innerHeight - items.length * 34 - 16 : position.y;
  const left = Math.max(8, Math.min(position.x, maxLeft));
  const top = Math.max(8, Math.min(position.y, maxTop));

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top }}
      className="fixed z-50 w-56 border border-[#dcd6cc] bg-cream py-1 shadow-lg"
    >
      {items.map((item) => (
        <ContextMenuRow key={item.key} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

function ContextMenuRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  if (item.items && item.items.length > 0) {
    return (
      <div
        className={item.separatorBefore ? "border-t border-[#e5e0d6] mt-1 pt-1" : ""}
      >
        <div className="group relative">
          <button
            type="button"
            disabled={item.disabled}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-caption text-charcoal hover:bg-nearwhite disabled:opacity-40"
          >
            {item.label}
            <span className="text-charcoal/40">▸</span>
          </button>
          <div className="invisible absolute left-full top-0 z-10 w-44 border border-[#dcd6cc] bg-cream py-1 shadow-lg group-hover:visible group-focus-within:visible">
            {item.items.map((sub) => (
              <button
                key={sub.key}
                type="button"
                disabled={sub.disabled}
                onClick={() => {
                  sub.onSelect?.();
                  onClose();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption text-charcoal hover:bg-nearwhite disabled:opacity-40"
              >
                {sub.swatch && (
                  <span
                    className="h-3 w-3 shrink-0 border border-charcoal/20"
                    style={{ backgroundColor: sub.swatch }}
                  />
                )}
                {sub.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={item.disabled}
      onClick={() => {
        item.onSelect?.();
        onClose();
      }}
      className={
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption text-charcoal hover:bg-nearwhite disabled:opacity-40" +
        (item.separatorBefore ? " mt-1 border-t border-[#e5e0d6] pt-2" : "")
      }
    >
      {item.swatch && (
        <span className="h-3 w-3 shrink-0 border border-charcoal/20" style={{ backgroundColor: item.swatch }} />
      )}
      {item.label}
    </button>
  );
}
