"use client";

import { useState } from "react";
import clsx from "clsx";
import type { Category, Item } from "@/types";
import { SpecRegister } from "./SpecRegister";
import { ProcurementView } from "./ProcurementView";
import { ProcurementBoardView } from "./ProcurementBoardView";

type View = "spec" | "procurement" | "board";

interface Props {
  projectId: string;
  initialItems: Item[];
  categories: Category[];
  budget: number | null;
}

/**
 * Owns the shared item state for a project and toggles between the
 * internal views over the same items (BUILD-SPEC.md §1, plus Week 9
 * "Procurement board"):
 *   - Spec view (default): design data only, no pricing/ordering.
 *   - Pricing & Procurement view (internal): pricing, totals, dates.
 *   - Board (Week 9, additive): kanban lens over the same items,
 *     grouped by status — visible to all team, shows NO pricing (see
 *     ProcurementBoardView.tsx's own doc comment). Drag-drop between
 *     columns PATCHes status through the SAME patchItem() function the
 *     other two views already use, so the existing Monday
 *     fire-and-forget sync (PATCH /api/items/[id]) fires identically
 *     regardless of which view triggered the status change.
 * Mutations live here so an edit in one view is reflected in the others.
 */
export function ProjectWorkspace({
  projectId,
  initialItems,
  categories,
  budget,
}: Props) {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [view, setView] = useState<View>("spec");
  const [error, setError] = useState<string | null>(null);

  async function patchItem(id: string, patch: Partial<Item>) {
    const prev = items;
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Update failed.");
      }
      const { item } = await res.json();
      setItems((cur) => cur.map((it) => (it.id === id ? item : it)));
    } catch (err) {
      setItems(prev);
      setError(err instanceof Error ? err.message : "Update failed.");
    }
  }

  async function deleteItem(id: string) {
    const prev = items;
    setItems((cur) => cur.filter((it) => it.id !== id));
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Delete failed.");
      }
    } catch (err) {
      setItems(prev);
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  function addItem(item: Item) {
    setItems((cur) => [...cur, item]);
  }

  /**
   * Week 7 — scrape status visibility: after adding an item with a
   * product URL, the scrape runs fire-and-forget server-side (see
   * POST /api/projects/[id]/items) and this row's initial state is
   * whatever came back synchronously (scrape_status: 'pending', no
   * images yet). Re-fetching the item a few seconds later and merging
   * it in-place (upsert by id, unlike addItem which always appends)
   * lets the row pick up the real scrape_status/images/flag_note
   * without the user having to manually reload the page. Silently
   * no-ops on failure — this is a best-effort background refresh, not
   * a user-facing action with its own error surface.
   */
  function upsertItem(item: Item) {
    setItems((cur) => {
      const exists = cur.some((it) => it.id === item.id);
      return exists ? cur.map((it) => (it.id === item.id ? item : it)) : [...cur, item];
    });
  }

  function scheduleItemRefetch(itemId: string, delayMs = 5000) {
    setTimeout(() => {
      fetch(`/api/items/${itemId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (body?.item) upsertItem(body.item as Item);
        })
        .catch(() => {});
    }, delayMs);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="flex border border-[#c9c2b4]">
          {(
            [
              ["spec", "Spec"],
              ["procurement", "Pricing & Procurement"],
              ["board", "Board"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={clsx(
                "px-4 py-2 text-subhead transition-colors",
                view === v
                  ? "bg-nearblack text-white"
                  : "text-charcoal hover:bg-nearwhite"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {view === "procurement" && (
          <span className="label-caps !text-sand">Internal only — never shown to clients</span>
        )}
      </div>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {view === "spec" ? (
        <SpecRegister
          projectId={projectId}
          items={items}
          categories={categories}
          onPatch={patchItem}
          onDelete={deleteItem}
          onAdd={addItem}
          onAddRefetch={scheduleItemRefetch}
          onError={setError}
        />
      ) : view === "procurement" ? (
        <ProcurementView
          items={items}
          categories={categories}
          budget={budget}
          onPatch={patchItem}
        />
      ) : (
        <ProcurementBoardView items={items} onPatch={patchItem} />
      )}
    </div>
  );
}
