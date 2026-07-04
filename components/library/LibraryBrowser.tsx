"use client";

import { useEffect, useState } from "react";
import type { Category, LibraryItem } from "@/types";

interface Props {
  categories: Category[];
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
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

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
        <input value={form.product_url} onChange={(e) => set("product_url", e.target.value)} className={field} />
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
