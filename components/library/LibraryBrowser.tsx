"use client";

import { useEffect, useState } from "react";
import type { Category, DuplicateMatch, LibraryItem } from "@/types";

interface Props {
  categories: Category[];
}

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

/**
 * Financial fields (price_trade, trade_price_received_at,
 * trade_price_source) are stripped entirely from the API response for
 * non-admin sessions (see app/api/library/route.ts) — the key is
 * deleted, not just nulled. That's what this checks: if the key isn't
 * present at all, this session can't see financials, so the trade
 * price panel doesn't render (BUILD-SPEC.md: "Non-admins see no
 * financials section at all").
 */
function hasFinancialAccess(item: LibraryItem): boolean {
  return "price_trade" in item;
}

/** Trade price age — BUILD-SPEC.md: "flag if older than ~6 months". */
function isTradePriceStale(receivedAt: string | null): boolean {
  if (!receivedAt) return false;
  const received = new Date(receivedAt + "T00:00:00");
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return received < sixMonthsAgo;
}

export function LibraryBrowser({ categories }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Debounced search.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (categoryFilter) params.set("category", categoryFilter);
      fetch(`/api/library?${params}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setItems(d.items ?? []))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, categoryFilter]);

  function prepend(item: LibraryItem) {
    setItems((cur) => [item, ...cur]);
  }
  function remove(id: string) {
    setItems((cur) => cur.filter((i) => i.id !== id));
  }
  function patch(id: string, next: LibraryItem) {
    setItems((cur) => cur.map((i) => (i.id === id ? next : i)));
  }

  const categoryName = new Map(categories.map((c) => [c.prefix, c.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, brand, supplier…"
          className="min-w-[240px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.prefix} value={c.prefix}>
              {c.prefix} · {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
        >
          {adding ? "Close" : "New product"}
        </button>
      </div>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {adding && (
        <LibraryForm
          categories={categories}
          onError={setError}
          onCreated={(item) => {
            prepend(item);
            setAdding(false);
          }}
        />
      )}

      {loading ? (
        <p className="text-body text-charcoal/50">Loading…</p>
      ) : items.length === 0 ? (
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">
            {q || categoryFilter
              ? "No products match your search."
              : "The library is empty. Add your first product."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <article
              key={item.id}
              className="flex flex-col justify-between border border-[#dcd6cc] bg-offwhite p-4"
            >
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="label-caps">
                    {item.category} · {categoryName.get(item.category) ?? ""}
                  </span>
                  {item.usage_count > 0 && (
                    <span className="text-caption text-charcoal/40">
                      used {item.usage_count}×
                    </span>
                  )}
                </div>
                <h3 className="mt-1 text-subhead text-nearblack">{item.name}</h3>
                <div className="mt-1 flex flex-wrap gap-x-4 text-body text-charcoal/60">
                  {item.brand && <span>{item.brand}</span>}
                  {item.supplier && <span>{item.supplier}</span>}
                </div>
                {(item.colour || item.material || item.finish) && (
                  <p className="mt-1 text-body text-charcoal/60">
                    {[item.colour, item.material, item.finish]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>

              {/* Trade price panel — admin-only (financial data), see
                  hasFinancialAccess() above. */}
              {hasFinancialAccess(item) && (
                <TradePricePanel item={item} onSaved={(next) => patch(item.id, next)} onError={setError} />
              )}

              <div className="mt-3 flex items-center justify-between border-t border-[#dcd6cc] pt-2">
                {item.product_url ? (
                  <a
                    href={item.product_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-caption text-charcoal/60 underline underline-offset-2 hover:text-nearblack"
                  >
                    Product page
                  </a>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`Delete "${item.name}" from the library?`)) return;
                    remove(item.id);
                    const res = await fetch(`/api/library/${item.id}`, {
                      method: "DELETE",
                    });
                    if (!res.ok) {
                      setError("Could not delete product");
                      prepend(item);
                    }
                  }}
                  className="text-caption text-charcoal/50 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Trade price + received date + source (BUILD-SPEC.md "Library — trade
 * price capture & duplicate detection"). Entering a trade price
 * auto-fills the received date to today (still editable); a subtle
 * hint appears once the price is >6 months old ("re-check with
 * supplier"). Only ever rendered for admin sessions — see
 * hasFinancialAccess() above — but the PATCH is also enforced
 * server-side (app/api/library/[id]/route.ts strips non-admin writes).
 */
function TradePricePanel({
  item,
  onSaved,
  onError,
}: {
  item: LibraryItem;
  onSaved: (next: LibraryItem) => void;
  onError: (msg: string | null) => void;
}) {
  const [price, setPrice] = useState(item.price_trade === null ? "" : String(item.price_trade));
  const [receivedAt, setReceivedAt] = useState(item.trade_price_received_at ?? "");
  const [source, setSource] = useState(item.trade_price_source ?? "");
  const [saving, setSaving] = useState(false);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/api/library/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save trade price");
      const { item: next } = await res.json();
      onSaved(next);
      if ("trade_price_received_at" in next) setReceivedAt(next.trade_price_received_at ?? "");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save trade price");
    } finally {
      setSaving(false);
    }
  }

  const stale = isTradePriceStale(receivedAt || null);

  return (
    <div className="mt-3 border-t border-[#dcd6cc] pt-2">
      <p className="label-caps mb-1 text-sand">Trade price (admin)</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <span className="text-caption text-charcoal/50">$</span>
          <input
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={() => {
              const next = price.trim() === "" ? null : Number(price);
              if (next === item.price_trade) return;
              save({ price_trade: next });
            }}
            disabled={saving}
            className="w-24 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-caption text-charcoal/50">Received</span>
          <input
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
            onBlur={() => {
              const next = receivedAt || null;
              if (next === item.trade_price_received_at) return;
              save({ trade_price_received_at: next });
            }}
            disabled={saving}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
          />
        </label>
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onBlur={() => {
            const next = source.trim() || null;
            if (next === item.trade_price_source) return;
            save({ trade_price_source: next });
          }}
          disabled={saving}
          placeholder="Source (e.g. supplier rep / quote #)"
          className="min-w-[160px] flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
        />
      </div>
      {item.price_trade !== null && (
        <p className="mt-1 text-caption text-charcoal/40">
          {aud.format(item.price_trade)}
          {stale && <span className="ml-2 text-sand">⚠ Price aged &gt;6 months — re-check with supplier.</span>}
        </p>
      )}
    </div>
  );
}

function LibraryForm({
  categories,
  onCreated,
  onError,
}: {
  categories: Category[];
  onCreated: (item: LibraryItem) => void;
  onError: (msg: string | null) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    category: categories[0]?.prefix ?? "",
    brand: "",
    supplier: "",
    supplier_email: "",
    colour: "",
    material: "",
    finish: "",
    product_url: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Non-blocking duplicate check on URL blur — BUILD-SPEC.md: "when a
  // product URL is pasted (add item, add library item, or import)...
  // offer 'Already in library — use existing item?'" — never blocks
  // creation, purely informational here.
  async function checkDuplicates() {
    const url = form.product_url.trim();
    if (!url) {
      setDuplicates([]);
      return;
    }
    try {
      const res = await fetch(`/api/library/check?url=${encodeURIComponent(url)}`);
      if (!res.ok) return;
      const body = await res.json();
      setDuplicates(body.duplicates ?? []);
    } catch {
      // Silent — informational only.
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.category) return;
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      const { item } = await res.json();
      onCreated(item);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSubmitting(false);
    }
  }

  const field = "border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none";

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-1 gap-3 border border-[#dcd6cc] bg-offwhite p-4 sm:grid-cols-3"
    >
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label-caps">Name</span>
        <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Category</span>
        <select value={form.category} onChange={(e) => set("category", e.target.value)} className={field}>
          {categories.map((c) => (
            <option key={c.prefix} value={c.prefix}>
              {c.prefix} · {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Brand</span>
        <input value={form.brand} onChange={(e) => set("brand", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Supplier</span>
        <input value={form.supplier} onChange={(e) => set("supplier", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Supplier email</span>
        <input value={form.supplier_email} onChange={(e) => set("supplier_email", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Colour</span>
        <input value={form.colour} onChange={(e) => set("colour", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Material</span>
        <input value={form.material} onChange={(e) => set("material", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Finish</span>
        <input value={form.finish} onChange={(e) => set("finish", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label-caps">Product URL</span>
        <input
          value={form.product_url}
          onChange={(e) => {
            set("product_url", e.target.value);
            setDuplicates([]);
          }}
          onBlur={checkDuplicates}
          className={field}
        />
        {duplicates.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {duplicates.map((d) => (
              <p key={`${d.source}-${d.id}`} className="text-caption text-sand">
                ⚠ Already {d.source === "library" ? "in library" : "in a project"}:{" "}
                {d.item_code ? `${d.item_code} — ` : ""}
                {d.name}
              </p>
            ))}
          </div>
        )}
      </label>
      <div className="sm:col-span-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Save to library"}
        </button>
      </div>
    </form>
  );
}
