"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import clsx from "clsx";
import type { Category, DuplicateMatch, Item, ItemStatus } from "@/types";
import { ItemAssets } from "./ItemAssets";
import { ItemNotes } from "./ItemNotes";
import { LibraryPicker } from "./LibraryPicker";

interface Props {
  projectId: string;
  items: Item[];
  categories: Category[];
  onPatch: (id: string, patch: Partial<Item>) => void;
  onDelete: (id: string) => void;
  onAdd: (item: Item) => void;
  /**
   * Week 7 — scrape status visibility: schedules a background re-fetch
   * of a single item a few seconds after it's added with a product URL,
   * so the fire-and-forget scrape's real result (image count, price
   * found, or a failure/flag) appears without a manual page reload.
   */
  onAddRefetch: (itemId: string, delayMs?: number) => void;
  onError: (msg: string | null) => void;
}

const ITEM_STATUSES: ItemStatus[] = [
  "Specced",
  "Quoted",
  "Ordered",
  "On Site",
  "Installed",
];

const UNASSIGNED = "Unassigned";

type GroupBy = "location" | "category";

// ── helpers ─────────────────────────────────────────────────

/** Collapse the four dimension fields to one line, omitting blanks. */
function formatDimensions(item: Item): string | null {
  const parts = [item.width_mm, item.height_mm, item.length_mm, item.depth_mm]
    .filter((v): v is number => v !== null && v !== undefined)
    .map((v) => String(v));
  return parts.length ? `${parts.join(" × ")} mm` : null;
}

/** Light validation — warn on implausible dimensions (Review §1C). */
function dimensionWarning(item: Item): string | null {
  const dims = [item.width_mm, item.height_mm, item.length_mm, item.depth_mm];
  if (dims.some((v) => v !== null && v !== undefined && v > 5000)) {
    return "Unusually large — check dimensions.";
  }
  if (item.width_mm === 210 && item.height_mm === 297) {
    return "Looks like an A4 swatch artefact (210 × 297).";
  }
  return null;
}

function num(v: number | null): string {
  return v === null || v === undefined ? "" : String(v);
}

// ── inline editable text cell ───────────────────────────────

function EditableCell({
  value,
  onCommit,
  placeholder,
  type = "text",
  className,
  align = "left",
}: {
  value: string | null;
  onCommit: (next: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  className?: string;
  align?: "left" | "right";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  function start() {
    setDraft(value ?? "");
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commit() {
    setEditing(false);
    if (draft.trim() !== (value ?? "").trim()) onCommit(draft.trim());
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className={clsx(
          "w-full border border-nearblack bg-nearwhite px-2 py-1.5 text-body text-charcoal focus:outline-none",
          align === "right" && "text-right",
          className
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      className={clsx(
        "block w-full px-2 py-1.5 text-body hover:bg-nearwhite",
        align === "right" ? "text-right" : "text-left",
        !value && "text-charcoal/30",
        className
      )}
    >
      {value || placeholder || "—"}
    </button>
  );
}

// ── main component ──────────────────────────────────────────

export function SpecRegister({
  projectId,
  items,
  categories,
  onPatch,
  onDelete,
  onAdd,
  onAddRefetch,
  onError,
}: Props) {
  const [groupBy, setGroupBy] = useState<GroupBy>("location");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sort_order - b.sort_order),
    [categories]
  );
  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((c) => map.set(c.prefix, c.name));
    return map;
  }, [categories]);

  // ── mutations (delegated to the workspace) ───────────────

  const patchItem = onPatch;
  const deleteItem = onDelete;

  function toggleExpand(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── filtering + grouping ─────────────────────────────────

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((it) => {
      if (categoryFilter !== "all" && it.category !== categoryFilter) return false;
      if (statusFilter !== "all" && it.status !== statusFilter) return false;
      if (!term) return true;
      return [it.name, it.item_code, it.supplier, it.brand, it.location]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(term));
    });
  }, [items, categoryFilter, statusFilter, search]);

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of filtered) {
      const key =
        groupBy === "location" ? it.location?.trim() || UNASSIGNED : it.category;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    const entries = [...map.entries()];
    if (groupBy === "location") {
      entries.sort((a, b) => {
        if (a[0] === UNASSIGNED) return 1;
        if (b[0] === UNASSIGNED) return -1;
        return a[0].localeCompare(b[0]);
      });
    } else {
      const order = new Map(sortedCategories.map((c, i) => [c.prefix, i]));
      entries.sort(
        (a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999)
      );
    }
    for (const [, list] of entries) {
      list.sort((a, b) => a.item_code.localeCompare(b.item_code));
    }
    return entries.map(([key, list]) => ({
      key,
      label:
        groupBy === "category"
          ? `${key} · ${categoryName.get(key) ?? key}`
          : key,
      items: list,
    }));
  }, [filtered, groupBy, sortedCategories, categoryName]);

  // ── render ───────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="label-caps">Group by</span>
          <div className="flex border border-[#c9c2b4]">
            {(["location", "category"] as GroupBy[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGroupBy(g)}
                className={clsx(
                  "px-3 py-1.5 text-subhead capitalize transition-colors",
                  groupBy === g
                    ? "bg-nearblack text-white"
                    : "text-charcoal hover:bg-nearwhite"
                )}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2">
          <span className="label-caps">Category</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:outline-none focus:border-nearblack"
          >
            <option value="all">All</option>
            {sortedCategories.map((c) => (
              <option key={c.prefix} value={c.prefix}>
                {c.prefix} · {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="label-caps">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:outline-none focus:border-nearblack"
          >
            <option value="all">All</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, code, supplier, brand, location…"
          className="min-w-[220px] border border-[#c9c2b4] bg-nearwhite px-3 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />

        <span className="text-body text-charcoal/50">
          {filtered.length} {filtered.length === 1 ? "item" : "items"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setLibraryOpen((o) => !o);
              setAdding(false);
            }}
            className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
          >
            {libraryOpen ? "Close" : "Add from library"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding((a) => !a);
              setLibraryOpen(false);
            }}
            className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal"
          >
            {adding ? "Close" : "Add item"}
          </button>
        </div>
      </div>

      {adding && (
        <AddItemForm
          projectId={projectId}
          categories={sortedCategories}
          onAdd={onAdd}
          onAddRefetch={onAddRefetch}
          onError={onError}
        />
      )}

      {libraryOpen && (
        <LibraryPicker
          projectId={projectId}
          categories={sortedCategories}
          onAdd={onAdd}
          onError={onError}
        />
      )}

      {/* Groups */}
      {filtered.length === 0 ? (
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">
            {items.length === 0
              ? "No items yet. Add the first one to start the register."
              : "No items match the current filters."}
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.key}>
            <div className="mb-2 flex items-baseline gap-3 border-b border-nearblack pb-1">
              <h2 className="label-caps !text-nearblack">{group.label}</h2>
              <span className="text-caption text-charcoal/50">
                {group.items.length}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[#dcd6cc] text-left">
                    <th className="w-6" />
                    <th className="w-12" />
                    <th className="label-caps px-2 py-1.5">Code</th>
                    <th className="label-caps px-2 py-1.5">Cat</th>
                    <th className="label-caps px-2 py-1.5">Name</th>
                    <th className="label-caps px-2 py-1.5 text-right">Qty</th>
                    <th className="label-caps px-2 py-1.5">Location</th>
                    <th className="label-caps px-2 py-1.5">Brand</th>
                    <th className="label-caps px-2 py-1.5">Supplier</th>
                    <th className="label-caps px-2 py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      categories={sortedCategories}
                      expanded={expanded.has(item.id)}
                      onToggle={() => toggleExpand(item.id)}
                      onPatch={(patch) => patchItem(item.id, patch)}
                      onDelete={() => deleteItem(item.id)}
                      onError={onError}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}

// ── item row (+ expandable detail) ──────────────────────────

function ItemRow({
  item: itemProp,
  categories,
  expanded,
  onToggle,
  onPatch,
  onDelete,
  onError,
}: {
  item: Item;
  categories: Category[];
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Item>) => void;
  onDelete: () => void;
  onError: (msg: string | null) => void;
}) {
  // Week 6 cleanup: this row used to keep a local-only `scrapeOverride`
  // because the generic PATCH /api/items/[id] route's EDITABLE_FIELDS
  // whitelist didn't include image_options/scrape_*/scraped_documents
  // at the time. That whitelist has since been verified to include all
  // of them (see app/api/items/[id]/route.ts's EDITABLE_FIELDS set —
  // "Week 4 whitelist fix"), so scrape/attach results now persist via
  // the normal onPatch round-trip like any other field, same as this
  // row's onPatch({ selected_image_url }) call below. No local override
  // needed — `item` is just the prop.
  const item = itemProp;

  const dims = formatDimensions(item);
  const warning = dimensionWarning(item);

  return (
    <>
      <tr className="border-b border-[#e5e0d6] align-top">
        <td className="pt-1">
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="px-1 py-1.5 text-charcoal/50 hover:text-nearblack"
          >
            {expanded ? "−" : "+"}
          </button>
        </td>
        <td className="py-1.5">
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="relative block h-9 w-9 overflow-hidden border border-[#dcd6cc] bg-cream"
          >
            {item.selected_image_url ? (
              <Image
                src={item.selected_image_url}
                alt=""
                fill
                sizes="36px"
                className="object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-caption text-charcoal/25">
                —
              </span>
            )}
          </button>
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-body font-normal text-nearblack">
          {item.item_code}
        </td>
        <td className="px-1 py-1">
          <select
            value={item.category}
            onChange={(e) => onPatch({ category: e.target.value })}
            title="Changing category does not change the existing item code"
            className="bg-transparent py-1 text-body focus:outline-none"
          >
            {categories.map((c) => (
              <option key={c.prefix} value={c.prefix}>
                {c.prefix}
              </option>
            ))}
          </select>
        </td>
        <td className="min-w-[180px] px-0 py-0">
          <EditableCell
            value={item.name}
            onCommit={(v) => v && onPatch({ name: v })}
          />
        </td>
        <td className="w-16 px-0 py-0">
          <EditableCell
            value={num(item.quantity)}
            type="number"
            align="right"
            onCommit={(v) => onPatch({ quantity: v === "" ? 1 : Number(v) })}
          />
        </td>
        <td className="min-w-[120px] px-0 py-0">
          <EditableCell
            value={item.location}
            placeholder="Unassigned"
            onCommit={(v) => onPatch({ location: v || null })}
          />
        </td>
        <td className="min-w-[110px] px-0 py-0">
          <EditableCell
            value={item.brand}
            onCommit={(v) => onPatch({ brand: v || null })}
          />
        </td>
        <td className="min-w-[110px] px-0 py-0">
          <EditableCell
            value={item.supplier}
            onCommit={(v) => onPatch({ supplier: v || null })}
          />
        </td>
        <td className="px-2 py-1">
          <select
            value={item.status}
            onChange={(e) =>
              onPatch({ status: e.target.value as ItemStatus })
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
      </tr>

      {expanded && (
        <tr className="border-b border-[#e5e0d6] bg-offwhite">
          <td />
          <td colSpan={9} className="px-2 py-4">
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailField label="Application note">
                <EditableCell
                  value={item.application_note}
                  onCommit={(v) => onPatch({ application_note: v || null })}
                />
              </DetailField>
              <DetailField label="Colour">
                <EditableCell
                  value={item.colour}
                  onCommit={(v) => onPatch({ colour: v || null })}
                />
              </DetailField>
              <DetailField label="Material">
                <EditableCell
                  value={item.material}
                  onCommit={(v) => onPatch({ material: v || null })}
                />
              </DetailField>
              <DetailField label="Finish">
                <EditableCell
                  value={item.finish}
                  onCommit={(v) => onPatch({ finish: v || null })}
                />
              </DetailField>
              <DetailField label="Unit">
                <EditableCell
                  value={item.unit}
                  onCommit={(v) => onPatch({ unit: v || "ea" })}
                />
              </DetailField>
              <DetailField label="Supplier email">
                <EditableCell
                  value={item.supplier_email}
                  onCommit={(v) => onPatch({ supplier_email: v || null })}
                />
              </DetailField>

              <DetailField label="Dimensions (W × H × L × D mm)" full>
                <div className="flex flex-wrap items-center gap-2">
                  {(["width_mm", "height_mm", "length_mm", "depth_mm"] as const).map(
                    (dim, i) => (
                      <div key={dim} className="flex items-center gap-2">
                        {i > 0 && <span className="text-charcoal/40">×</span>}
                        <input
                          type="number"
                          defaultValue={num(item[dim])}
                          onBlur={(e) => {
                            const raw = e.target.value;
                            const next = raw === "" ? null : Number(raw);
                            if (next !== item[dim]) onPatch({ [dim]: next });
                          }}
                          className="w-20 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
                          aria-label={dim}
                        />
                      </div>
                    )
                  )}
                  {dims && (
                    <span className="text-body text-charcoal/50">= {dims}</span>
                  )}
                </div>
                {warning && (
                  <p className="mt-1 text-caption text-sand">⚠ {warning}</p>
                )}
              </DetailField>

              <DetailField label="Description" full>
                <EditableCell
                  value={item.description}
                  onCommit={(v) => onPatch({ description: v || null })}
                />
              </DetailField>

              <DetailField label="Product URL" full>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <EditableCell
                      value={item.product_url}
                      onCommit={(v) => onPatch({ product_url: v || null })}
                    />
                  </div>
                  <FetchDetailsButton
                    itemId={item.id}
                    scrapeStatus={item.scrape_status}
                    // The scraper (POST /api/items/[id]/scrape) writes
                    // image_options/scrape_status/scraped_documents etc.
                    // server-side via the service-role client, then
                    // returns the updated item. Persisting that through
                    // the normal onPatch round-trip (rather than a
                    // local-only override) re-PATCHes the same
                    // already-correct values back — a harmless no-op
                    // write — and, more importantly, syncs this row's
                    // state from the PATCH response, exactly like any
                    // other field edit on this row.
                    onScraped={(patch) => onPatch(patch)}
                    onError={onError}
                  />
                </div>
                {/* Scrape status visibility (Week 7, user-reported:
                    "not sure if the scraper is working") — shows the
                    outcome of the last scrape attempt explicitly rather
                    than leaving it silently invisible. */}
                <ScrapeStatusLine item={item} />
              </DetailField>

              <div className="border-t border-[#dcd6cc] pt-4 sm:col-span-2 lg:col-span-3">
                <ItemAssets
                  itemId={item.id}
                  selectedImageUrl={item.selected_image_url}
                  onImage={(url) =>
                    onPatch({ selected_image_url: url || null })
                  }
                  onError={onError}
                  scrapedDocuments={item.scraped_documents}
                  onDocumentAttached={(url) =>
                    onPatch({
                      scraped_documents: (item.scraped_documents ?? []).filter(
                        (d) => d.url !== url
                      ),
                    })
                  }
                />
              </div>

              <div className="border-t border-[#dcd6cc] pt-4 sm:col-span-2 lg:col-span-3">
                <ItemNotes itemId={item.id} onError={onError} />
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-[#dcd6cc] pt-3">
              <span className="text-caption text-charcoal/40">
                {item.client_approved
                  ? "Client approved"
                  : item.client_flagged
                    ? "Client flagged"
                    : "Not yet actioned by client"}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `Remove ${item.item_code} — ${item.name}? It is soft-deleted and can be restored by an admin.`
                    )
                  )
                    onDelete();
                }}
                className="border border-red-700/40 px-3 py-1.5 text-subhead text-red-700 transition-colors hover:bg-red-700 hover:text-white"
              >
                Remove item
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DetailField({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={full ? "sm:col-span-2 lg:col-span-3" : undefined}>
      <p className="label-caps mb-1">{label}</p>
      {children}
    </div>
  );
}

/**
 * "Fetch details" / "Retry" — triggers POST /api/items/[id]/scrape
 * (Week 3 scraper: lib/scraper/index.ts), which writes image_options,
 * scrape_status, scraped_documents, etc. directly to the DB via the
 * service-role client and returns the updated item. onScraped hands
 * that patch to the row's normal onPatch (Week 6 cleanup — see the
 * comment on ItemRow's `item = itemProp` line): the generic
 * PATCH /api/items/[id] route's EDITABLE_FIELDS whitelist covers all
 * of these fields now, so there's no need for a local-only override
 * that risked drifting out of sync with the server.
 *
 * Week 7 — scrape status visibility: the button's label reflects
 * whether the LAST attempt failed ("Retry") vs. this being the first
 * attempt or a re-fetch of an already-successful scrape ("Fetch
 * details" / "Fetch again"), so the same control doubles as the
 * failed-scrape retry affordance the user asked for.
 */
function FetchDetailsButton({
  itemId,
  scrapeStatus,
  onScraped,
  onError,
}: {
  itemId: string;
  scrapeStatus: Item["scrape_status"];
  onScraped: (patch: Partial<Item>) => void;
  onError: (msg: string | null) => void;
}) {
  const [loading, setLoading] = useState(false);

  async function fetchDetails() {
    setLoading(true);
    onError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/scrape`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "Could not fetch product details.");
      }
      if (body.item) onScraped(body.item as Partial<Item>);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not fetch product details.");
    } finally {
      setLoading(false);
    }
  }

  const idleLabel =
    scrapeStatus === "failed"
      ? "Retry"
      : scrapeStatus === "success" || scrapeStatus === "partial"
        ? "Fetch again"
        : "Fetch details";

  return (
    <button
      type="button"
      onClick={fetchDetails}
      disabled={loading}
      className="shrink-0 border border-[#c9c2b4] px-3 py-1.5 text-subhead text-charcoal transition-colors hover:border-nearblack hover:text-nearblack disabled:opacity-60"
    >
      {loading ? "Fetching…" : idleLabel}
    </button>
  );
}

/**
 * Scrape status visibility (Week 7, user-reported: "not sure if the
 * scraper is working"). Renders the outcome of the item's LAST scrape
 * attempt explicitly, directly under the Product URL field:
 *   - pending: a spinner note — either never scraped yet (no
 *     scrape_attempted_at) or a scrape is in flight (fire-and-forget
 *     from item creation, before this row has re-fetched).
 *   - success / partial: image count + whether a price was found, plus
 *     the attempt timestamp.
 *   - failed: the scrape_flag_note (if the scraper left one) plus a
 *     reminder that the "Retry" button above will try again.
 *   - vision / skipped: treated as informational variants of success
 *     (the scraper did run, just via a different path / chose not to
 *     act) rather than a failure state.
 * scrape_flagged (separately from scrape_status) surfaces as an
 * additional warning line whenever it's true, regardless of status —
 * the scraper can flag a low-confidence result even on an otherwise
 * "successful" attempt.
 */
function ScrapeStatusLine({ item }: { item: Item }) {
  if (!item.product_url) return null;

  const attemptedAt = item.scrape_attempted_at
    ? new Date(item.scrape_attempted_at).toLocaleString("en-AU", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  if (!item.scrape_attempted_at && item.scrape_status === "pending") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-caption text-charcoal/50">
        <SpinnerDot /> Fetching product details…
      </p>
    );
  }

  if (item.scrape_status === "failed") {
    return (
      <div className="mt-1 text-caption text-red-700">
        <p>
          ⚠ Scrape failed{attemptedAt ? ` (${attemptedAt})` : ""}
          {item.scrape_flag_note ? ` — ${item.scrape_flag_note}` : ""}.
        </p>
        <p className="text-charcoal/50">Use Retry above to try again.</p>
      </div>
    );
  }

  // success / partial / vision / skipped — all "the scraper ran" states.
  const imageCount = item.image_options?.length ?? 0;
  const priceFound = item.price_rrp !== null && item.price_rrp !== undefined;
  const partial = item.scrape_status === "partial";

  return (
    <div className="mt-1 text-caption">
      <p className={partial ? "text-sand" : "text-charcoal/50"}>
        {partial ? "Partial — " : ""}
        {imageCount} {imageCount === 1 ? "image" : "images"}
        {priceFound ? ", price found" : ", no price found"}
        {attemptedAt ? ` · ${attemptedAt}` : ""}
      </p>
      {item.scrape_flagged && (
        <p className="text-sand">
          ⚠ Flagged for review{item.scrape_flag_note ? `: ${item.scrape_flag_note}` : ""}.
        </p>
      )}
      {/* Week 8A — dimension auto-fill note (BUILD-SPEC.md "Dimension
          extraction (best-effort)"): the scraper leaves an FYI note in
          scrape_flag_note WITHOUT setting scrape_flagged when it
          auto-fills a dimension, so it must render here on its own
          condition rather than being folded into the scrape_flagged
          branch above (which would otherwise silently swallow it). */}
      {!item.scrape_flagged && item.scrape_flag_note && (
        <p className="text-sand">ⓘ {item.scrape_flag_note}</p>
      )}
    </div>
  );
}

function SpinnerDot() {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 animate-pulse rounded-full bg-charcoal/40"
    />
  );
}

// ── add-item form ───────────────────────────────────────────

function AddItemForm({
  projectId,
  categories,
  onAdd,
  onAddRefetch,
  onError,
}: {
  projectId: string;
  categories: Category[];
  onAdd: (item: Item) => void;
  onAddRefetch: (itemId: string, delayMs?: number) => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState(categories[0]?.prefix ?? "");
  const [location, setLocation] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [productUrl, setProductUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Duplicate detection (BUILD-SPEC.md "Library — trade price capture &
  // duplicate detection"): non-blocking — checked on URL field blur, the
  // user can still create the item regardless. "Use library item" swaps
  // this add into a library-linked add instead (library_item_id), which
  // the items POST route hydrates defaults from.
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [libraryItemId, setLibraryItemId] = useState<string | null>(null);

  async function checkDuplicates() {
    const url = productUrl.trim();
    if (!url) {
      setDuplicates([]);
      return;
    }
    setCheckingDuplicates(true);
    try {
      const res = await fetch(`/api/library/check?url=${encodeURIComponent(url)}`);
      if (!res.ok) return;
      const body = await res.json();
      setDuplicates(body.duplicates ?? []);
    } catch {
      // Non-blocking lookup — silently ignore failures.
    } finally {
      setCheckingDuplicates(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !category) return;
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category,
          location: location.trim() || undefined,
          quantity: Number(quantity) || 1,
          product_url: productUrl.trim() || undefined,
          library_item_id: libraryItemId ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add item.");
      }
      const { item } = await res.json();
      onAdd(item);
      // Scrape status visibility (Week 7): the scrape kicked off by
      // POST /api/projects/[id]/items runs fire-and-forget — `item` here
      // is whatever came back synchronously (scrape_status: 'pending').
      // Re-fetch this one item a few seconds later so its row can pick
      // up the real result (images found, price found, or a failure/
      // flag) without the user manually reloading the page.
      if (productUrl.trim()) {
        onAddRefetch(item.id);
      }
      // keep the row open for rapid entry — reset name/location, keep category
      setName("");
      setLocation("");
      setQuantity("1");
      setProductUrl("");
      setDuplicates([]);
      setLibraryItemId(null);
      nameRef.current?.focus();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add item.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 border border-[#dcd6cc] bg-offwhite p-4"
    >
      <div className="min-w-[200px] flex-1">
        <label className="label-caps mb-1 block">Name</label>
        <input
          ref={nameRef}
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Undermount Basin"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div className="min-w-[220px] flex-1">
        <label className="label-caps mb-1 block">Product URL (optional)</label>
        <input
          type="url"
          value={productUrl}
          onChange={(e) => {
            setProductUrl(e.target.value);
            setLibraryItemId(null);
            setDuplicates([]);
          }}
          onBlur={checkDuplicates}
          placeholder="Paste supplier product page — details fetched automatically"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        {checkingDuplicates && (
          <p className="mt-1 text-caption text-charcoal/40">Checking for duplicates…</p>
        )}
        {!checkingDuplicates && duplicates.length > 0 && (
          <div className="mt-1 space-y-1">
            {duplicates.map((d) => (
              <p
                key={`${d.source}-${d.id}`}
                className="flex flex-wrap items-center gap-2 text-caption text-sand"
              >
                <span>
                  ⚠ Already {d.source === "library" ? "in library" : "in this project"}:{" "}
                  {d.item_code ? `${d.item_code} — ` : ""}
                  {d.name}
                </span>
                {d.source === "library" && (
                  <button
                    type="button"
                    onClick={() => setLibraryItemId(d.id)}
                    className={clsx(
                      "border px-2 py-0.5 text-caption transition-colors",
                      libraryItemId === d.id
                        ? "border-nearblack bg-nearblack text-white"
                        : "border-[#c9c2b4] text-charcoal hover:border-nearblack"
                    )}
                  >
                    {libraryItemId === d.id ? "Using library item ✓" : "Use library item"}
                  </button>
                )}
              </p>
            ))}
          </div>
        )}
      </div>
      <div>
        <label className="label-caps mb-1 block">Category</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
        >
          {categories.map((c) => (
            <option key={c.prefix} value={c.prefix}>
              {c.prefix} · {c.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label-caps mb-1 block">Location</label>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Ensuite"
          className="w-36 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <div>
        <label className="label-caps mb-1 block">Qty</label>
        <input
          type="number"
          min="0"
          step="any"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="w-20 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <p className="w-full text-caption text-charcoal/40">
        The item code (e.g. {category || "TW"}-01) is generated automatically per
        project.
      </p>
    </form>
  );
}
