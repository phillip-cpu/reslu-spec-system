"use client";

import { useMemo } from "react";
import clsx from "clsx";
import type { Category, Item, ItemStatus } from "@/types";

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

interface Props {
  items: Item[];
  categories: Category[];
  budget: number | null;
  onPatch: (id: string, patch: Partial<Item>) => void;
}

// ── computations ────────────────────────────────────────────

/** Client sell price = trade × (1 + markup%). Null if no trade price. */
function clientPrice(item: Item): number | null {
  if (item.price_trade === null || item.price_trade === undefined) return null;
  return item.price_trade * (1 + (item.markup_pct ?? 0) / 100);
}

function lineTotal(item: Item): number | null {
  const cp = clientPrice(item);
  return cp === null ? null : cp * item.quantity;
}

function tradeTotal(item: Item): number | null {
  if (item.price_trade === null || item.price_trade === undefined) return null;
  return item.price_trade * item.quantity;
}

type Risk = { label: string; tone: "late" | "risk" } | null;

/** Late/at-risk from ETA (BUILD-SPEC.md §1.3). Delivered items clear. */
function riskFlag(item: Item): Risk {
  if (item.delivered_at || item.status === "Installed") return null;
  if (!item.eta) return null;
  const eta = new Date(item.eta + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
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

// ── main component ──────────────────────────────────────────

export function ProcurementView({ items, categories, budget, onPatch }: Props) {
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
        subtotal: list.reduce((s, it) => s + (lineTotal(it) ?? 0), 0),
      }));
  }, [items, sortedCategories, categoryName]);

  const totals = useMemo(() => {
    const sell = items.reduce((s, it) => s + (lineTotal(it) ?? 0), 0);
    const cost = items.reduce((s, it) => s + (tradeTotal(it) ?? 0), 0);
    return {
      sell,
      cost,
      margin: sell - cost,
      gst: sell * GST_RATE,
      incGst: sell * (1 + GST_RATE),
      priced: items.filter((it) => it.price_trade !== null).length,
    };
  }, [items]);

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
                      className="border-b border-[#e5e0d6] align-middle"
                    >
                      <td className="px-2 py-1.5 text-body text-nearblack">
                        {item.item_code}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1.5 text-body">
                        {item.name}
                      </td>
                      <td className="px-2 py-1.5 text-right text-body">
                        {item.quantity}
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
                        {money(lineTotal(item))}
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
