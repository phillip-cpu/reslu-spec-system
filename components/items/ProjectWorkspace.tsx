"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { Category, Item, ProjectAllocation, RoomWithCount } from "@/types";
import type { MeasurementWithGroup } from "@/types";
import type { OrderByResponse } from "@/types/order-by";
import { SpecRegister } from "./SpecRegister";
import { ProcurementView } from "./ProcurementView";
import { ProcurementBoardView } from "./ProcurementBoardView";

type View = "spec" | "procurement" | "board";

interface Props {
  projectId: string;
  initialItems: Item[];
  categories: Category[];
  budget: number | null;
  /**
   * Round B — needed so ProcurementView knows whether to fetch/offer
   * the measurement-link picker (takeoff → FF&E quantity link). The
   * measurements list itself comes from the same admin-gated route the
   * Estimate module already uses (GET
   * /api/projects/[id]/estimate/measurements/groups — BUILD-SPEC.md
   * §Financial visibility treats Areas & Measurements as
   * estimate-adjacent data), so a non-admin session simply never
   * fetches it and the picker/derived-qty UI doesn't render — same
   * "hidden, not merely disabled" gating this page already applies to
   * the Estimate/Invoices tabs one level up.
   */
  isAdmin: boolean;
  /** My Work focus deep-link support — see doc comment on `view`'s useState below. */
  initialView?: View;
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
  isAdmin,
  initialView,
}: Props) {
  const [items, setItems] = useState<Item[]>(initialItems);
  // "Three from Phillip — 6 July 2026 evening" item 1 (My Work focus
  // deep-links): the decision_overdue My Work source links here as
  // `?tab=ffe&focus=decision_overdue-<id>`, targeting a row id that
  // only exists in ProcurementView (interim decision — SpecRegister.tsx
  // is protected this round; see docs/HANDOFF-focus-register.md). If
  // the view still defaulted to "spec" that row would never mount, so
  // FocusOnLoad would find nothing — the page (server component, which
  // already awaits searchParams) computes this and passes it down as a
  // plain prop, rather than this client component calling
  // useSearchParams itself (which would require its own Suspense
  // boundary this component tree doesn't have).
  const [view, setView] = useState<View>(initialView ?? "spec");
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomWithCount[]>([]);
  const [allocations, setAllocations] = useState<ProjectAllocation[]>([]);
  // Round B — flat, group-annotated measurements list for
  // ProcurementView's measurement-link picker (same shape/source the
  // Estimate tab's MeasurementLinkPicker already consumes). Admin-only
  // fetch, only triggered once the Procurement view is actually opened
  // (not on initial page load) — no point paying for this request on
  // every visit to the Spec view, which never needs it.
  const [measurements, setMeasurements] = useState<MeasurementWithGroup[]>([]);
  const [measurementsLoaded, setMeasurementsLoaded] = useState(false);
  // Order-by engine (8 July 2026) — the ORDER BY column's derived
  // data (lib/order-by.ts, via GET /api/projects/[id]/order-by).
  // Deliberately mirrors the measurements lazy-load immediately above:
  // admin-only (the route itself 403s a non-admin, but this component
  // additionally never even calls it for a non-admin session, same
  // "hidden, not merely disabled" discipline the measurements fetch
  // uses), and only triggered once the Procurement view is actually
  // opened — no point paying for this request on every visit to the
  // Spec view, which never renders the ORDER BY column at all.
  const [orderBy, setOrderBy] = useState<OrderByResponse | null>(null);
  const [orderByLoaded, setOrderByLoaded] = useState(false);

  // Rooms + per-room allocations for the spec register's Room grouping and
  // per-item editor. Loaded client-side (they change often via bulk assign).
  function refetchRooms() {
    fetch(`/api/projects/${projectId}/rooms`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.rooms)) setRooms(d.rooms);
      })
      .catch(() => {});
    fetch(`/api/projects/${projectId}/items/rooms`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.allocations)) setAllocations(d.allocations);
      })
      .catch(() => {});
  }
  useEffect(() => {
    refetchRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Round B — lazy-load measurements the first time an admin opens the
  // Procurement view (not on initial mount, and never at all for a
  // non-admin session — see the isAdmin doc comment on Props above).
  useEffect(() => {
    if (view !== "procurement" || !isAdmin || measurementsLoaded) return;
    setMeasurementsLoaded(true);
    fetch(`/api/projects/${projectId}/estimate/measurements/groups`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body?.groups) return;
        const flat: MeasurementWithGroup[] = (
          body.groups as { name: string; measurements: MeasurementWithGroup[] }[]
        ).flatMap((g) => g.measurements.map((m) => ({ ...m, group_name: g.name })));
        setMeasurements(flat);
      })
      .catch(() => {
        // Best-effort — the picker/derived-qty UI just won't have data
        // to offer if this fails; ProcurementView already degrades to
        // "no measurements yet" copy for an empty list.
      });
  }, [view, isAdmin, measurementsLoaded, projectId]);

  // Order-by engine — lazy-load the ORDER BY column's data the first
  // time an admin opens the Procurement view, same trigger condition as
  // the measurements fetch immediately above (not on initial mount,
  // never at all for a non-admin session).
  useEffect(() => {
    if (view !== "procurement" || !isAdmin || orderByLoaded) return;
    setOrderByLoaded(true);
    fetch(`/api/projects/${projectId}/order-by`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: OrderByResponse | null) => {
        if (body) setOrderBy(body);
      })
      .catch(() => {
        // Best-effort — ProcurementView renders no ORDER BY chips at
        // all (falls back to a blank/'—' cell) if this fails, same
        // "degrade quietly" behaviour as the measurements fetch.
      });
  }, [view, isAdmin, orderByLoaded, projectId]);

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
          rooms={rooms}
          allocations={allocations}
          onRoomsChanged={refetchRooms}
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
          measurements={isAdmin ? measurements : []}
          isAdmin={isAdmin}
          orderBy={isAdmin ? orderBy : null}
        />
      ) : (
        <ProcurementBoardView items={items} onPatch={patchItem} />
      )}
    </div>
  );
}
