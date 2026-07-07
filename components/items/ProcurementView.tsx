"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import type { Category, Item, ItemStatus, MeasurementWithGroup } from "@/types";
import { MeasurementLinkPicker } from "@/components/estimate/MeasurementLinkPicker";
import { derivedQuantity, derivedQuantityNote } from "@/lib/item-quantity";

const ITEM_STATUSES: ItemStatus[] = [
  "Specced",
  "Quoted",
  "Ordered",
  "On Site",
  "Installed",
];

const GST_RATE = 0.1;

const aud = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/**
 * Round B — items don't carry measurement_id/wastage_pct/
 * coverage_per_unit on the shared `Item` type (types/index.ts is
 * protected this round — see types/round-b.ts's header comment), but
 * the columns exist on every real row returned by the API (migration
 * 027). This local type widens Item with those three fields so the
 * call sites below (an `as ItemWithQtyLink` cast, since the shared
 * `Item` type doesn't declare them) can pass a properly-typed object
 * into lib/item-quantity.ts's DerivedQuantityItemInput, which expects
 * them present-but-nullable, never undefined — every item this
 * component actually receives at runtime has them in that exact shape.
 */
type ItemWithQtyLink = Item & {
  measurement_id: string | null;
  wastage_pct: number | null;
  coverage_per_unit: number | null;
};

interface Props {
  items: Item[];
  categories: Category[];
  budget: number | null;
  onPatch: (id: string, patch: Partial<Item>) => void;
  /**
   * Round B — flat, group-annotated measurements for the
   * measurement-link picker (empty for a non-admin session — see
   * ProjectWorkspace.tsx's isAdmin gating one level up). Same shape
   * components/estimate/MeasurementLinkPicker.tsx already consumes.
   */
  measurements?: MeasurementWithGroup[];
  /** Round B — gates the link/unlink affordance itself, not just the data. */
  isAdmin?: boolean;
}

// ── computations ────────────────────────────────────────────

/** Client sell price = trade × (1 + markup%). Null if no trade price. */
function clientPrice(item: Item): number | null {
  if (item.price_trade === null || item.price_trade === undefined) return null;
  return item.price_trade * (1 + (item.markup_pct ?? 0) / 100);
}

/**
 * Round B: optional `qtyOverride` lets a caller pass the derived
 * (measurement-linked) quantity instead of the raw item.quantity
 * column — see resolvedQuantity() below, which every call site in this
 * file now goes through. Omitting it (or an unlinked item) behaves
 * exactly as before — backwards compatible with any other caller of
 * this module-level helper.
 */
function lineTotal(item: Item, qtyOverride?: number): number | null {
  const cp = clientPrice(item);
  return cp === null ? null : cp * (qtyOverride ?? item.quantity);
}

function tradeTotal(item: Item, qtyOverride?: number): number | null {
  if (item.price_trade === null || item.price_trade === undefined) return null;
  return item.price_trade * (qtyOverride ?? item.quantity);
}

/**
 * Round B: resolves the quantity to actually cost an item against —
 * derivedQuantity() (measurement value × wastage, coverage-converted)
 * when the item is linked and its measurement is resolvable, else the
 * plain item.quantity column. Every rollup helper above/below takes
 * this as the qtyOverride so a takeoff-linked item's dollar figures
 * stay correct without duplicating the derivation logic per call site.
 */
function resolvedQuantity(
  item: ItemWithQtyLink,
  measurementsById: Map<string, MeasurementWithGroup>
): number {
  const measurement = item.measurement_id ? measurementsById.get(item.measurement_id) ?? null : null;
  return derivedQuantity(item, measurement).quantity;
}

type Risk = { label: string; tone: "late" | "risk" } | null;

/**
 * Late/at-risk from ETA (BUILD-SPEC.md §1.3). Delivered items clear.
 *
 * Bug fix, 8 July 2026: `eta` was parsed via local-midnight
 * (`+ "T00:00:00"`, no explicit zone) and `today` via
 * `new Date(); .setHours(0,0,0,0)` — both truncate using the RUNTIME's
 * own local timezone, which differs between the server (Vercel, UTC)
 * and the client (a browser in Adelaide, UTC+9:30/+10:30) for roughly
 * 9.5–10.5 hours of every day. Since `today` itself lands on a
 * different calendar day between the two environments in that window,
 * the computed `days` value could differ by one between server-
 * rendered HTML and client hydration — a genuine React hydration
 * mismatch (error #418), same root cause as
 * components/board/ProjectBoard.tsx's identical fix. Anchoring `today`
 * to an explicit Australia/Adelaide calendar date (Intl.DateTimeFormat)
 * and parsing both dates as UTC-midnight-of-that-calendar-day
 * (`Date.UTC`, timezone-runtime-independent) makes the whole
 * computation deterministic regardless of which timezone the
 * executing environment's own clock happens to be in.
 */
function riskFlag(item: Item): Risk {
  if (item.delivered_at || item.status === "Installed") return null;
  if (!item.eta) return null;
  const parseUTC = (dateStr: string) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const todayAdelaide = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(new Date());
  const eta = parseUTC(item.eta);
  const today = parseUTC(todayAdelaide);
  const days = Math.round((eta.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { label: "Late", tone: "late" };
  if (days <= 14 && item.status !== "Ordered" && item.status !== "On Site") {
    return { label: `Due ${days}d`, tone: "risk" };
  }
  return null;
}

function money(v: number | null): string {
  return v === null ? "—" : aud.format(v);
}

// ── inline editors (uncontrolled; remount on value change via key) ──

function NumCell({
  value,
  onCommit,
  width = "w-24",
  suffix,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  width?: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        key={String(value)}
        type="number"
        step="any"
        defaultValue={value ?? ""}
        onBlur={(e) => {
          const raw = e.target.value;
          const next = raw === "" ? null : Number(raw);
          if (next !== value) onCommit(next);
        }}
        className={clsx(
          width,
          "border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-right text-body focus:border-nearblack focus:outline-none"
        )}
      />
      {suffix && <span className="text-caption text-charcoal/40">{suffix}</span>}
    </div>
  );
}

function DateCell({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
}) {
  return (
    <input
      key={String(value)}
      type="date"
      defaultValue={value ?? ""}
      onBlur={(e) => {
        const v = e.target.value || null;
        if (v !== value) onCommit(v);
      }}
      className="w-36 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
    />
  );
}

/**
 * Round B — the Qty cell for a spec-register item, gaining a
 * measurement-link affordance mirroring the Estimate module's per-line
 * "📏" link icon (see components/estimate/EstimateView.tsx's usage of
 * MeasurementLinkPicker). Three states:
 *   1. Not admin: plain read-only quantity, no link UI at all (the
 *      picker's data source is admin-gated — see ProcurementView's
 *      isAdmin prop doc comment).
 *   2. Admin, unlinked: plain NumCell (editable quantity, as before)
 *      plus a small "🔗" link button that opens the picker.
 *   3. Admin, linked: computed quantity (derivedQuantity()) shown
 *      read-only with a "linked · +10%" caption (derivedQuantityNote())
 *      and an "Unlink" affordance — BUILD-SPEC.md "unlink-to-edit":
 *      unlinking clears measurement_id (and wastage_pct/
 *      coverage_per_unit, meaningless without a link) and reverts to a
 *      plain editable NumCell showing the last hand-typed
 *      items.quantity value, exactly mirroring the Estimate module's
 *      MeasurementLinkPicker onSelect(null) handler.
 */
function QtyCell({
  item,
  isAdmin,
  measurements,
  measurementsById,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onPatch,
}: {
  item: Item;
  isAdmin: boolean;
  measurements: MeasurementWithGroup[];
  measurementsById: Map<string, MeasurementWithGroup>;
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onPatch: (id: string, patch: Partial<Item>) => void;
}) {
  const linked = item as ItemWithQtyLink;
  const measurement = linked.measurement_id ? measurementsById.get(linked.measurement_id) ?? null : null;
  const result = derivedQuantity(linked, measurement);
  const note = derivedQuantityNote(linked, result);

  if (!isAdmin) {
    return <span>{item.quantity}</span>;
  }

  if (result.linked && measurement) {
    return (
      <div className="relative flex flex-col items-end gap-0.5">
        <span className="text-nearblack">{result.quantity}</span>
        {note && <span className="text-caption !text-sand">{note}</span>}
        <button
          type="button"
          onClick={() =>
            onPatch(item.id, {
              measurement_id: null,
              wastage_pct: null,
            } as Partial<Item>)
          }
          className="text-caption text-charcoal/50 underline hover:text-nearblack"
        >
          Unlink
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex items-center justify-end gap-1">
      <NumCell
        value={item.quantity}
        width="w-16"
        onCommit={(v) => onPatch(item.id, { quantity: v ?? 0 })}
      />
      <button
        type="button"
        title="Link to a measurement"
        onClick={onOpenPicker}
        className="text-caption text-charcoal/40 hover:text-nearblack"
      >
        🔗
      </button>
      {pickerOpen && (
        <div className="absolute right-0 top-full z-10 mt-1">
          <MeasurementLinkPicker
            measurements={measurements}
            currentMeasurementId={linked.measurement_id ?? null}
            onSelect={(measurementId) => {
              onPatch(item.id, { measurement_id: measurementId } as Partial<Item>);
              onClosePicker();
            }}
            onClose={onClosePicker}
          />
        </div>
      )}
    </div>
  );
}

// ── main component ──────────────────────────────────────────

export function ProcurementView({
  items,
  categories,
  budget,
  onPatch,
  measurements = [],
  isAdmin = false,
}: Props) {
  // Round B — which item's measurement-link picker is currently open
  // (null = none). Only one open at a time, same "single open popover"
  // shape the Estimate module's per-row link picker uses.
  const [linkPickerFor, setLinkPickerFor] = useState<string | null>(null);

  const measurementsById = useMemo(
    () => new Map(measurements.map((m) => [m.id, m])),
    [measurements]
  );

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sort_order - b.sort_order),
    [categories]
  );
  const categoryName = useMemo(() => {
    const m = new Map<string, string>();
    categories.forEach((c) => m.set(c.prefix, c.name));
    return m;
  }, [categories]);

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      if (!map.has(it.category)) map.set(it.category, []);
      map.get(it.category)!.push(it);
    }
    const order = new Map(sortedCategories.map((c, i) => [c.prefix, i]));
    return [...map.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
      .map(([prefix, list]) => ({
        prefix,
        label: `${prefix} · ${categoryName.get(prefix) ?? prefix}`,
        items: list.sort((a, b) => a.item_code.localeCompare(b.item_code)),
        subtotal: list.reduce(
          (s, it) => s + (lineTotal(it, resolvedQuantity(it as ItemWithQtyLink, measurementsById)) ?? 0),
          0
        ),
      }));
  }, [items, sortedCategories, categoryName, measurementsById]);

  const totals = useMemo(() => {
    const sell = items.reduce(
      (s, it) => s + (lineTotal(it, resolvedQuantity(it as ItemWithQtyLink, measurementsById)) ?? 0),
      0
    );
    const cost = items.reduce(
      (s, it) => s + (tradeTotal(it, resolvedQuantity(it as ItemWithQtyLink, measurementsById)) ?? 0),
      0
    );
    return {
      sell,
      cost,
      margin: sell - cost,
      gst: sell * GST_RATE,
      incGst: sell * (1 + GST_RATE),
      priced: items.filter((it) => it.price_trade !== null).length,
    };
  }, [items, measurementsById]);

  const variance = budget === null ? null : budget - totals.sell;

  if (items.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">
          No items to price yet. Add items in the Spec view first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Totals panel */}
      <div className="grid grid-cols-2 gap-px border border-[#dcd6cc] bg-[#dcd6cc] md:grid-cols-4">
        <Stat label="Quote subtotal (ex-GST)" value={money(totals.sell)} />
        <Stat label="GST (10%)" value={money(totals.gst)} />
        <Stat label="Quote total (inc GST)" value={money(totals.incGst)} strong />
        <Stat
          label="Trade cost / margin"
          value={`${money(totals.cost)} · ${money(totals.margin)}`}
        />
        <Stat
          label="Project budget (ex-GST)"
          value={budget === null ? "Not set" : money(budget)}
        />
        <Stat
          label={variance !== null && variance < 0 ? "Over budget" : "Under budget"}
          value={variance === null ? "—" : money(Math.abs(variance))}
          tone={variance !== null && variance < 0 ? "over" : "under"}
        />
        <Stat
          label="Items priced"
          value={`${totals.priced} / ${items.length}`}
        />
        <Stat label="Line items" value={String(items.length)} />
      </div>

      {/* Per-category tables */}
      {groups.map((group) => (
        <section key={group.prefix}>
          <div className="mb-2 flex items-baseline justify-between border-b border-nearblack pb-1">
            <h2 className="label-caps !text-nearblack">{group.label}</h2>
            <span className="text-body text-charcoal/70">
              {money(group.subtotal)}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse whitespace-nowrap">
              <thead>
                <tr className="border-b border-[#dcd6cc] text-left">
                  <th className="label-caps px-2 py-1.5">Code</th>
                  <th className="label-caps px-2 py-1.5">Name</th>
                  <th className="label-caps px-2 py-1.5 text-right">Qty</th>
                  <th className="label-caps px-2 py-1.5 text-right">Trade $</th>
                  <th className="label-caps px-2 py-1.5 text-right">Markup %</th>
                  <th className="label-caps px-2 py-1.5 text-right">Client $</th>
                  <th className="label-caps px-2 py-1.5 text-right">Line total</th>
                  <th className="label-caps px-2 py-1.5 text-right">Lead wks</th>
                  <th className="label-caps px-2 py-1.5">Ordered</th>
                  <th className="label-caps px-2 py-1.5">ETA</th>
                  <th className="label-caps px-2 py-1.5">Delivered</th>
                  <th className="label-caps px-2 py-1.5">Status</th>
                  <th className="label-caps px-2 py-1.5">Flag</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => {
                  const risk = riskFlag(item);
                  return (
                    <tr
                      key={item.id}
                      id={`focus-decision_overdue-${item.id}`}
                      className="border-b border-[#e5e0d6] align-middle"
                    >
                      <td className="px-2 py-1.5 text-body text-nearblack">
                        {item.item_code}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1.5 text-body">
                        {item.name}
                      </td>
                      <td className="px-2 py-1.5 text-right text-body">
                        <QtyCell
                          item={item}
                          isAdmin={isAdmin}
                          measurementsById={measurementsById}
                          pickerOpen={linkPickerFor === item.id}
                          onOpenPicker={() => setLinkPickerFor(item.id)}
                          onClosePicker={() => setLinkPickerFor(null)}
                          measurements={measurements}
                          onPatch={onPatch}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <NumCell
                          value={item.price_trade}
                          onCommit={(v) => onPatch(item.id, { price_trade: v })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <NumCell
                          value={item.markup_pct}
                          width="w-20"
                          onCommit={(v) => onPatch(item.id, { markup_pct: v })}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right text-body text-charcoal/70">
                        {money(clientPrice(item))}
                      </td>
                      <td className="px-2 py-1.5 text-right text-body text-nearblack">
                        {money(lineTotal(item, resolvedQuantity(item as ItemWithQtyLink, measurementsById)))}
                      </td>
                      <td className="px-2 py-1">
                        <NumCell
                          value={item.lead_time_weeks}
                          width="w-16"
                          onCommit={(v) =>
                            onPatch(item.id, { lead_time_weeks: v })
                          }
                        />
                      </td>
                      <td className="px-2 py-1">
                        <DateCell
                          value={item.ordered_at}
                          onCommit={(v) => onPatch(item.id, { ordered_at: v })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <DateCell
                          value={item.eta}
                          onCommit={(v) => onPatch(item.id, { eta: v })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <DateCell
                          value={item.delivered_at}
                          onCommit={(v) => onPatch(item.id, { delivered_at: v })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={item.status}
                          onChange={(e) =>
                            onPatch(item.id, {
                              status: e.target.value as ItemStatus,
                            })
                          }
                          className="bg-transparent py-1 text-body focus:outline-none"
                        >
                          {ITEM_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        {risk && (
                          <span
                            className={clsx(
                              "label-caps inline-block border px-2 py-1",
                              risk.tone === "late"
                                ? "border-red-700 !text-red-700"
                                : "border-sand !text-sand"
                            )}
                          >
                            {risk.label}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "over" | "under";
}) {
  return (
    <div className="bg-offwhite px-4 py-3">
      <p className="label-caps mb-1">{label}</p>
      <p
        className={clsx(
          "text-subhead",
          strong && "text-nearblack",
          tone === "over" && "!text-red-700",
          tone === "under" && "!text-sand"
        )}
      >
        {value}
      </p>
    </div>
  );
}
