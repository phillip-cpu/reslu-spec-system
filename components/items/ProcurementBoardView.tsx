"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import clsx from "clsx";
import type { Contact, Item, ItemStatus } from "@/types";
import { renditionUrl, RENDITION_SIZES } from "@/lib/image-url";
import { BOARD_LAYOUT_STORAGE_KEY, type BoardLayoutMode } from "@/types/phase-fix-a";

interface Props {
  items: Item[];
  onPatch: (id: string, patch: Partial<Item>) => void;
}

const STATUS_COLUMNS: ItemStatus[] = [
  "Specced",
  "Quoted",
  "Ordered",
  "On Site",
  "Installed",
];

/**
 * Fix round B — BUILD-SPEC.md §"Board vertical layout": "Boards scroll
 * UP/DOWN, not left/right ... Vertical becomes the DEFAULT layout; the
 * side-by-side kanban stays available via a small layout toggle
 * (persist per user in localStorage) ... Applies to project boards,
 * procurement board view, office board consistency ... Vertical is the
 * universal default across every board surface."
 *
 * Shares the SAME localStorage key AND value vocabulary as the project
 * board's layout toggle (BOARD_LAYOUT_STORAGE_KEY / BoardLayoutMode from
 * types/phase-fix-a.ts) so a user's layout choice actually carries over
 * across every board surface in the app, not just the same key name.
 */
function readStoredLayout(): BoardLayoutMode {
  if (typeof window === "undefined") return "stacked";
  const stored = window.localStorage.getItem(BOARD_LAYOUT_STORAGE_KEY);
  return stored === "side-by-side" ? "side-by-side" : "stacked";
}

/**
 * Procurement board — BUILD-SPEC.md "Procurement board": "a kanban
 * VIEW over existing items, no new tables ... columns fixed to the
 * status lifecycle (Specced/Quoted/Ordered/On Site/Installed), cards:
 * thumbnail, item_code, name, supplier + contact chip, drag between
 * columns = PATCH status via the existing /api/items/[id] route (which
 * already fire-and-forgets Monday sync — verify you reuse it, never
 * bypass)."
 *
 * This component NEVER shows pricing — no price_trade/price_rrp/
 * markup_pct/line totals anywhere in its render tree, unlike
 * ProcurementView.tsx (the Pricing & Procurement grid) which this is
 * named similarly to but is functionally distinct from. Visible to all
 * team, not admin-gated, per the build spec's "shows NO pricing" +
 * "team-visible" requirement.
 *
 * Status changes go through the SAME onPatch prop ProjectWorkspace.tsx
 * already wires to PATCH /api/items/[id] for the Spec/P&P views — this
 * component never calls fetch() directly, so the existing Monday
 * fire-and-forget sync on a transition to "Ordered" (see that route's
 * PATCH handler) fires exactly as it does from any other status edit,
 * with zero duplicated logic.
 */
export function ProcurementBoardView({ items, onPatch }: Props) {
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<ItemStatus | null>(null);
  const [contactById, setContactById] = useState<Map<string, Contact>>(new Map());
  const [layout, setLayout] = useState<BoardLayoutMode>("stacked");

  // Read the persisted layout choice on mount only (avoids a
  // hydration mismatch — SSR always renders "stacked" as the default,
  // matching readStoredLayout()'s SSR fallback).
  useEffect(() => {
    setLayout(readStoredLayout());
  }, []);

  function setAndPersistLayout(next: BoardLayoutMode) {
    setLayout(next);
    window.localStorage.setItem(BOARD_LAYOUT_STORAGE_KEY, next);
  }

  // Batched lookup for the supplier contact chip — items only carry
  // supplier_contact_id, so the linked contacts' display names are
  // fetched once (not per-card) whenever the set of referenced ids
  // changes, mirroring the batched-lookup pattern GET
  // /api/projects/[id]/board uses server-side for board task chips.
  useEffect(() => {
    const ids = [...new Set(items.map((it) => it.supplier_contact_id).filter(Boolean))] as string[];
    if (ids.length === 0) {
      setContactById(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(ids.map((id) => fetch(`/api/contacts/${id}`).then((r) => (r.ok ? r.json() : null))))
      .then((results) => {
        if (cancelled) return;
        const map = new Map<string, Contact>();
        for (const r of results) {
          if (r?.contact) map.set(r.contact.id, r.contact as Contact);
        }
        setContactById(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((it) => it.supplier_contact_id).join(",")]);

  const columns = STATUS_COLUMNS.map((status) => ({
    status,
    items: items.filter((it) => it.status === status),
  }));

  function onDrop(status: ItemStatus) {
    setDragOverStatus(null);
    if (!dragItemId) return;
    const item = items.find((it) => it.id === dragItemId);
    setDragItemId(null);
    if (!item || item.status === status) return;
    onPatch(item.id, { status });
  }

  if (items.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">
          No items to track yet. Add items in the Spec view first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Layout toggle — vertical (stacked, default) vs kanban (side-by-side).
          BUILD-SPEC.md §"Board vertical layout". */}
      <div className="flex items-center gap-1 border-b border-[#dcd6cc] pb-2">
        <button
          type="button"
          onClick={() => setAndPersistLayout("stacked")}
          className={clsx(
            "label-caps border px-3 py-1.5",
            layout === "stacked" ? "border-nearblack !text-nearblack" : "border-[#dcd6cc] !text-charcoal/50 hover:!text-nearblack"
          )}
        >
          Stacked
        </button>
        <button
          type="button"
          onClick={() => setAndPersistLayout("side-by-side")}
          className={clsx(
            "label-caps border px-3 py-1.5",
            layout === "side-by-side" ? "border-nearblack !text-nearblack" : "border-[#dcd6cc] !text-charcoal/50 hover:!text-nearblack"
          )}
        >
          Side by side
        </button>
      </div>

      {layout === "stacked" ? (
        <div className="space-y-6">
          {columns.map((column) => (
            <div
              key={column.status}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStatus(column.status);
              }}
              onDragLeave={() => setDragOverStatus(null)}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(column.status);
              }}
              className={clsx(
                "border bg-offwhite",
                dragOverStatus === column.status ? "border-nearblack" : "border-[#dcd6cc]"
              )}
            >
              <div className="border-b border-[#dcd6cc] px-3 py-2">
                <span className="label-caps !text-nearblack">
                  {column.status} · {column.items.length}
                </span>
              </div>
              {column.items.length === 0 ? (
                <p className="px-3 py-3 text-caption text-charcoal/40">No items in this status.</p>
              ) : (
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[#e5e0d6] text-caption text-charcoal/40">
                      <th className="w-14 px-3 py-1.5 font-normal"></th>
                      <th className="px-3 py-1.5 font-normal">Code</th>
                      <th className="px-3 py-1.5 font-normal">Name</th>
                      <th className="px-3 py-1.5 font-normal">Supplier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {column.items.map((item) => (
                      <tr
                        key={item.id}
                        draggable
                        onDragStart={() => setDragItemId(item.id)}
                        className="cursor-move border-b border-[#e5e0d6] last:border-b-0 hover:bg-nearwhite"
                      >
                        <td className="px-3 py-2">
                          <div className="relative h-10 w-10 shrink-0 overflow-hidden border border-[#dcd6cc] bg-cream">
                            {item.selected_image_url ? (
                              <Image
                                src={renditionUrl(item.selected_image_url, { width: RENDITION_SIZES.thumb }) ?? item.selected_image_url}
                                alt=""
                                fill
                                sizes="40px"
                                className="object-cover"
                              />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center text-caption text-charcoal/25">
                                —
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-caption text-charcoal/50">{item.item_code}</td>
                        <td className="px-3 py-2 text-body text-nearblack">{item.name}</td>
                        <td className="px-3 py-2">
                          {item.supplier && (
                            <span className="text-caption text-charcoal/50">{item.supplier}</span>
                          )}
                          {item.supplier_contact_id && contactById.get(item.supplier_contact_id) && (
                            <span className="label-caps ml-2 inline-block border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
                              {contactById.get(item.supplier_contact_id)!.company}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <div
              key={column.status}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStatus(column.status);
              }}
              onDragLeave={() => setDragOverStatus(null)}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(column.status);
              }}
              className={clsx(
                "w-64 shrink-0 border bg-offwhite",
                dragOverStatus === column.status ? "border-nearblack" : "border-[#dcd6cc]"
              )}
            >
              <div className="border-b border-[#dcd6cc] px-3 py-2">
                <span className="label-caps !text-nearblack">
                  {column.status} · {column.items.length}
                </span>
              </div>
              <div className="space-y-2 p-2">
                {column.items.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={() => setDragItemId(item.id)}
                    className="flex cursor-move gap-2 border border-[#dcd6cc] bg-cream p-2 shadow-sm"
                  >
                    <div className="relative h-10 w-10 shrink-0 overflow-hidden border border-[#dcd6cc] bg-cream">
                      {item.selected_image_url ? (
                        <Image
                          src={renditionUrl(item.selected_image_url, { width: RENDITION_SIZES.thumb }) ?? item.selected_image_url}
                          alt=""
                          fill
                          sizes="40px"
                          className="object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-caption text-charcoal/25">
                          —
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-caption text-charcoal/50">{item.item_code}</p>
                      <p className="truncate text-body text-nearblack">{item.name}</p>
                      {item.supplier && (
                        <p className="truncate text-caption text-charcoal/50">{item.supplier}</p>
                      )}
                      {item.supplier_contact_id && contactById.get(item.supplier_contact_id) && (
                        <span className="label-caps mt-1 inline-block border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
                          {contactById.get(item.supplier_contact_id)!.company}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
