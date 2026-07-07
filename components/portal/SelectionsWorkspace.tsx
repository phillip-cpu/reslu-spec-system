"use client";

import { useState } from "react";
import clsx from "clsx";
import type { PortalItemWithFiles } from "@/app/portal/types";
import { AwaitingFlaggedList } from "@/components/portal/AwaitingFlaggedList";
import { YourSelectionsGallery, type YourSelectionGalleryItem } from "@/components/portal/YourSelectionsGallery";

type Tab = "awaiting" | "flagged" | "approved";

/**
 * The full "Your selections" workspace — BUILD-SPEC.md §"Portal
 * selections separation" (Quick items round, 6 July 2026, "stronger
 * cut"): "verify it has tabs/filters (Awaiting / Flagged / Approved) +
 * room grouping + the review-one-by-one stepper — extend it if the fix
 * round left gaps (it may currently be approved-only: check)."
 *
 * It WAS approved-only (app/portal/[token]/selections/page.tsx rendered
 * only YourSelectionsGallery, a read-only grid of client_approved items
 * — Fix Round B never finished moving the Awaiting/Flagged rendering
 * off the main page). This component is the fix: it owns ALL item
 * state for the sub-page (one shared `items` array, sourced from the
 * SAME full PORTAL_FIELDS query the main page already ran — see that
 * page's doc comment for why passing full items down here, rather than
 * re-querying, is both simpler and avoids a second round-trip) and
 * renders three tabs:
 *
 *   - Awaiting — AwaitingFlaggedList filtered to not-yet-decided items
 *     (room-grouped, bulk-approve, review-one-by-one stepper).
 *   - Flagged — AwaitingFlaggedList filtered to flagged items (same
 *     component, same room-grouping/expand behaviour, bulk-approve
 *     naturally excludes flagged items already).
 *   - Approved — YourSelectionsGallery (read-only thumbnail grid,
 *     unchanged from the fix round).
 *
 * Owning `items` state at THIS level (rather than inside
 * AwaitingFlaggedList, which used to own it back when it was the only
 * thing rendering on the main page) means an approve/flag action stays
 * correct even if the client switches tabs mid-review — there is only
 * ever one source of truth for "is this item approved/flagged" on this
 * page, and the Approved tab's count updates immediately after an
 * approval without a page reload.
 */
export function SelectionsWorkspace({
  token,
  initialItems,
}: {
  token: string;
  initialItems: PortalItemWithFiles[];
}) {
  const [items, setItems] = useState<PortalItemWithFiles[]>(initialItems);
  const [justApprovedIds, setJustApprovedIds] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>(() => {
    const awaitingCount = initialItems.filter((i) => !i.client_approved && !i.client_flagged).length;
    const flaggedCount = initialItems.filter((i) => i.client_flagged).length;
    // Default to whichever tab actually needs attention — Awaiting
    // first, then Flagged, falling back to Approved only when there is
    // nothing left to decide (mirrors the main page's own "you're all
    // caught up" framing).
    if (awaitingCount > 0) return "awaiting";
    if (flaggedCount > 0) return "flagged";
    return "approved";
  });

  function handleUpdate(updated: PortalItemWithFiles[] | PortalItemWithFiles) {
    const list = Array.isArray(updated) ? updated : [updated];
    setItems((cur) =>
      cur.map((it) => {
        const match = list.find((u) => u.id === it.id);
        return match ? { ...it, ...match, files: it.files } : it;
      })
    );
    const newlyApproved = list.filter((u) => u.client_approved).map((u) => u.id);
    if (newlyApproved.length > 0) {
      setJustApprovedIds((cur) => new Set([...cur, ...newlyApproved]));
    }
  }

  function dismissApprovedNote(id: string) {
    setJustApprovedIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  }

  const awaitingCount = items.filter((i) => !i.client_approved && !i.client_flagged).length;
  const flaggedCount = items.filter((i) => i.client_flagged).length;
  const approvedCount = items.filter((i) => i.client_approved).length;

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: "awaiting", label: "Awaiting", count: awaitingCount },
    { key: "flagged", label: "Flagged", count: flaggedCount },
    { key: "approved", label: "Approved", count: approvedCount },
  ];

  const approvedGalleryItems: YourSelectionGalleryItem[] = items
    .filter((i) => i.client_approved)
    .map((i) => ({
      id: i.id,
      item_code: i.item_code,
      name: i.name,
      rooms: i.rooms,
      selected_image_url: i.selected_image_url,
    }));

  return (
    <div>
      {/* Mobile-first: tabs scroll horizontally on narrow viewports rather than wrapping/shrinking illegibly. */}
      <div className="mb-6 flex gap-2 overflow-x-auto border-b border-[#dcd6cc] pb-px">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={clsx(
              "label-caps shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 pt-1",
              tab === t.key
                ? "border-nearblack !text-nearblack"
                : "border-transparent !text-charcoal/50 hover:!text-nearblack"
            )}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {tab === "awaiting" && (
        <AwaitingFlaggedList
          token={token}
          items={items}
          filter="awaiting"
          justApprovedIds={justApprovedIds}
          onUpdate={handleUpdate}
          onDismissApprovedNote={dismissApprovedNote}
        />
      )}
      {tab === "flagged" && (
        <AwaitingFlaggedList
          token={token}
          items={items}
          filter="flagged"
          justApprovedIds={justApprovedIds}
          onUpdate={handleUpdate}
          onDismissApprovedNote={dismissApprovedNote}
        />
      )}
      {tab === "approved" && <YourSelectionsGallery token={token} items={approvedGalleryItems} />}
    </div>
  );
}
